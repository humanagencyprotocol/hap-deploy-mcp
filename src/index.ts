#!/usr/bin/env node
/**
 * Deploy MCP Server — make already-built software live, through GitHub Actions.
 *
 * The gated action is a RELEASE, not a build. Building harms nobody: a preview
 * sitting at a URL nobody visits has no consequence. Serving it to real users
 * does. So the agent never builds here — it activates a build that already
 * exists, which means the human can OPEN it and look before approving, and no
 * rebuild can diverge from what was approved.
 *
 * Env vars:
 *   GITHUB_TOKEN — fine-grained token, one repository, with
 *                  Actions: read & write · Environments: read · Contents: read
 *                  Deliberately NOT Contents: write — this server ships commits
 *                  that already exist, it never authors them.
 *
 * The gateway gates every tool here. Two properties matter and are easy to
 * lose:
 *
 *   1. `release` declares `receipt_id` in its schema. That declaration is what
 *      makes the gateway inject the receipt after minting it. Remove it and the
 *      pipeline has nothing to verify — the chain silently degrades to an
 *      unproven release.
 *   2. The token is read from the environment, never from an argument. An agent
 *      that could supply its own credential would have routed around the point.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as gh from './github-api.js';

const server = new McpServer({ name: 'deploy-mcp', version: '0.2.0' });

const fail = (e: unknown) => ({
  content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }],
  isError: true,
});
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });

/**
 * Attach the source commit a deployment's built page actually displays.
 *
 * `sha` on a `DeploymentRecord` is GitHub's trigger ref — the commit the
 * pipeline ran at, which can be a build-artifact commit (a dist-only merge
 * tip). The page itself stamps a different value at build time: the last
 * non-build source commit. `release` binds — and the public receipt lookup
 * checks against — the STAMPED value, not the trigger sha. This is the one
 * place a caller can see both before proposing a release, so a mismatch
 * gets caught here rather than at `release` time (which is fail-closed but
 * only runs after a receipt already exists).
 */
async function withProvenance(repo: string, d: gh.DeploymentRecord) {
  // Git is the authority: digest of what goes live + the source commit,
  // derived from history by the build workflow's own rule. No page fetch,
  // no host credentials, works for a private staged build.
  let provenance: gh.ArtifactProvenance | null = null;
  let provenanceError: string | null = null;
  try {
    provenance = await gh.resolveArtifact(repo, d.sha, gh.artifactPathFromEnv());
  } catch (e) {
    provenanceError = e instanceof Error ? e.message : String(e);
  }

  // The page footer is a cross-check, not the gate: read it when reachable,
  // report agreement or contradiction, and say plainly when it is unreadable.
  const stamped = d.url ? await gh.fetchStampedCommit(d.url) : null;
  let stampedNote: string;
  if (!d.url) {
    stampedNote = 'No deployment URL yet — nothing to cross-check.';
  } else if (stamped == null) {
    stampedNote =
      `Could not read a "Built from <sha>" link from ${d.url} (unreachable, private, or no such link). ` +
      'Not needed: release binds the git-derived sourceCommit below. Open the URL yourself if you want to inspect the build.';
  } else if (provenance && stamped.toLowerCase() === provenance.sourceCommit.toLowerCase()) {
    stampedNote = 'The page footer agrees with the git-derived sourceCommit.';
  } else if (provenance) {
    stampedNote =
      `CONTRADICTION: the page footer names ${stamped.slice(0, 7)} but git history says the artifact was built ` +
      `from ${provenance.sourceCommit.slice(0, 7)}. release will refuse this build until that is explained.`;
  } else {
    stampedNote = `The page footer names ${stamped.slice(0, 7)}; git-derived provenance is unavailable (see provenanceError).`;
  }

  const sourceNote = provenance
    ? provenance.sourceCommit === d.sha
      ? 'sourceCommit equals the trigger sha: this commit was deployed directly.'
      : `sourceCommit differs from the trigger sha (${d.sha.slice(0, 7)}): the deployed commit is a build artifact ` +
        `recording ${provenance.sourceCommit.slice(0, 7)} as its source. Use sourceCommit as release.commit; ` +
        `release refuses the trigger sha.`
    : `Could not derive provenance from git: ${provenanceError}. release will refuse this build.`;

  return {
    ...d,
    ...(provenance ?? {
      artifactDigest: null,
      digestKind: null,
      artifactPath: gh.artifactPathFromEnv(),
      sourceCommit: null,
      triggerCommit: d.sha,
    }),
    provenanceError,
    sourceCommitNote: sourceNote,
    stampedSourceCommit: stamped,
    stampedSourceCommitNote: stampedNote,
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

server.tool(
  'resolve_ref',
  'Resolve a branch, tag or commit to a concrete commit SHA. Call this BEFORE deploying: a deploy is authorised for one specific commit, not for whatever a branch points at later.',
  {
    repo: z.string().describe('Repository as owner/name'),
    ref: z.string().describe('Branch, tag or commit SHA (e.g. "main")'),
  },
  async ({ repo, ref }) => {
    try {
      const c = await gh.resolveRef(repo, ref);
      return ok(JSON.stringify(c, null, 2));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'list_deployments',
  'List deployments and their URLs — the candidates that can be released. Each carries the immutable address of that exact build, which is what a human opens to see what they would be approving. ' +
    'The `sha` shown here is the trigger commit, not necessarily what the built page displays or what release binds — for a build-artifact repo head these can diverge. This call does not fetch every page to check (that cost scales with the list), so before proposing a release call get_deployment on the chosen id and use its `stampedSourceCommit` field.',
  {
    repo: z.string().describe('Repository as owner/name'),
    environment: z.string().optional().describe('Filter by environment'),
    limit: z.number().optional().describe('How many to return (default 10)'),
  },
  async ({ repo, environment, limit }) => {
    try {
      return ok(JSON.stringify(await gh.listDeployments(repo, environment, limit ?? 10), null, 2));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'get_deployment',
  'Get one deployment by id with its provenance derived from git: `sourceCommit` (the commit the artifact was ' +
    'built from — use THIS as release.commit, never `sha`, which is only the trigger ref and may be a build-artifact ' +
    'commit) and `artifactDigest` (git tree sha; `digestKind` says whether it digests the served bytes or the source). ' +
    'Neither needs the page to be reachable. `stampedSourceCommit` is the page footer\'s value when readable — a ' +
    'cross-check that can only refuse, never the gate. Read `sourceCommitNote` before proposing.',
  {
    repo: z.string().describe('Repository as owner/name'),
    deployment_id: z.number().describe('Deployment id from list_deployments'),
  },
  async ({ repo, deployment_id }) => {
    try {
      const deployment = await gh.getDeployment(repo, deployment_id);
      return ok(JSON.stringify(await withProvenance(repo, deployment), null, 2));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'list_environments',
  'List the deployment environments a repository defines. Names are the host\'s own vocabulary, not a fixed set.',
  { repo: z.string().describe('Repository as owner/name') },
  async ({ repo }) => {
    try {
      return ok(JSON.stringify(await gh.listEnvironments(repo), null, 2));
    } catch (e) {
      return fail(e);
    }
  },
);

// ─── Consequential ───────────────────────────────────────────────────────────

server.tool(
  'release',
  'Make an already-built deployment live for real users. Requires a receipt: the pipeline verifies it before anything is served. Call list_deployments first — you release a specific build, identified by its URL. ' +
    'Supply the source commit it was built from: that is what the receipt binds, and what the released page displays, so a reader can check the two against each other. ' +
    'Get that value from get_deployment\'s `sourceCommit` (derived from git history), not from a repo\'s HEAD/trigger sha — when the head is a build-artifact commit the two diverge. ' +
    'This tool re-derives the source commit from git itself and refuses (fail-closed) if the commit you supplied differs, or if the page footer, when readable, names a different one.',
  {
    repo: z.string().describe('Repository as owner/name'),
    workflow: z.string().describe('Pipeline that performs the release, e.g. deploy-website.yml'),
    environment: z.string().describe('Target environment, e.g. production'),
    deployment_url: z
      .string()
      .describe('Immutable URL of the build to make live, from list_deployments. This is what the human inspects and what the receipt binds.'),
    commit: z
      .string()
      .describe(
        'Source commit this build was produced from (full 40-char sha). THIS is what the receipt binds. ' +
        'The deployment URL identifies the bytes but is assigned after they exist, so a page can never ' +
        'carry it; the source commit is known before the build and is already shown on the released page, ' +
        'which is what lets a reader tie the page to an approval without any account access.',
      ),
    branch: z
      .string()
      .optional()
      .describe('Branch the pipeline is dispatched on (default "main"). Nothing is built from it — the release activates deployment_url.'),
    // Declared so the gateway injects the minted receipt. Not supplied by the
    // agent — anything it passes is overwritten by the real one.
    receipt_id: z.string().optional().describe('Injected by the gateway after the receipt is issued'),
  },
  async ({ repo, workflow, environment, deployment_url, commit, branch, receipt_id }) => {
    try {
      if (!receipt_id) {
        // Ungated call, or the schema declaration was lost in a refactor.
        // Refuse rather than release something the pipeline cannot verify.
        return fail(new Error(
          'No receipt_id was supplied. This tool must be called through a Suveren gateway, ' +
          'which injects the receipt after authorising the release. Nothing was dispatched.',
        ));
      }
      if (!/^https:\/\/[^\s]+$/.test(deployment_url)) {
        return fail(new Error(
          `"${deployment_url}" is not a deployment URL. Use list_deployments to find the build to release.`,
        ));
      }

      if (!/^[0-9a-f]{40}$/i.test(commit)) {
        // A short sha binds a prefix, and a prefix is not an identity — nor is
        // it what the released page displays in full.
        return fail(new Error(
          `"${commit}" is not a full 40-character commit sha. The receipt binds this value exactly.`,
        ));
      }

      // Fail-closed source-commit guard. This runs AFTER the receipt already
      // exists, so its job is narrow but load-bearing: stop a receipt that is
      // already minted from going live bound to the wrong commit.
      //
      // Git is the authority. The deployment URL is resolved back to its
      // deployment, the source commit is re-derived from history (the build
      // workflow's own rule), and `commit` must match it. The page footer,
      // when readable, is a cross-check that can only refuse — an unreadable
      // page (a private staged build) no longer blocks anything, because the
      // derivation never needed it.
      const deployment = await gh.findDeploymentByUrl(repo, deployment_url);
      if (!deployment) {
        return fail(new Error(
          `Refusing to release: ${deployment_url} does not belong to any recent deployment of ${repo}. ` +
          'Use list_deployments and pass a URL from there; nothing was dispatched.',
        ));
      }
      let provenance: gh.ArtifactProvenance;
      try {
        provenance = await gh.resolveArtifact(repo, deployment.sha, gh.artifactPathFromEnv());
      } catch (e) {
        return fail(new Error(
          `Refusing to release: could not derive from git which commit ${deployment_url} was built from ` +
          `(${e instanceof Error ? e.message : String(e)}). An underivable source is not evidence that ` +
          `"${commit}" is the right commit to bind; nothing was dispatched.`,
        ));
      }
      const stamped = await gh.fetchStampedCommit(deployment_url);
      const verdict = gh.checkSourceCommit({ supplied: commit, derived: provenance.sourceCommit, stamped });
      if (verdict.status === 'mismatch') {
        return fail(new Error(
          `Refusing to release: git history says ${deployment_url} was built from ${verdict.derived}, but ` +
          `commit "${commit}" was supplied to bind the receipt. The receipt would certify a commit the ` +
          `artifact was not built from. Use ${verdict.derived} as the "commit" argument (get_deployment ` +
          `reports it as sourceCommit) and retry; nothing was dispatched.`,
        ));
      }
      if (verdict.status === 'page-contradicts') {
        return fail(new Error(
          `Refusing to release: git history and the supplied commit agree on ${commit.slice(0, 7)}, but the ` +
          `page at ${deployment_url} displays "Built from ${verdict.stamped.slice(0, 7)}". A footer that ` +
          `disagrees with git means the build is not what its history says, or the footer is wrong; neither ` +
          `may go live. Nothing was dispatched.`,
        ));
      }

      const dispatchedAt = Date.now();
      await gh.dispatchWorkflow({
        repo,
        workflow,
        ref: branch ?? 'main',
        // `commit` reaches the pipeline so it can refuse to promote an artifact
        // that was NOT built from the approved source — the one gap that binding
        // a commit rather than the bytes would otherwise leave open.
        inputs: { deployment_url, receipt_id, environment, commit },
      });

      const run = await gh.findRunSince(repo, workflow, dispatchedAt);
      const where = run ? `\nRun ${run.id}: ${run.html_url}` : '\nRun id not yet visible.';
      return ok(
        `Releasing ${deployment_url} to ${environment}.${where}\n` +
        `The pipeline verifies receipt ${receipt_id} binds commit ${commit.slice(0, 7)}, and that this build came from it, before serving anything.`,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[deploy-mcp] ready');
