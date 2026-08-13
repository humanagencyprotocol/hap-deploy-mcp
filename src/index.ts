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
async function withStampedCommit(d: gh.DeploymentRecord) {
  if (!d.url) {
    return {
      ...d,
      stampedSourceCommit: null,
      stampedSourceCommitNote:
        'No deployment URL yet — nothing to fetch. Once one appears, call get_deployment again ' +
        'before proposing a release: `sha` alone is not reliable evidence of the source commit.',
    };
  }
  const stamped = await gh.fetchStampedCommit(d.url);
  const note = stamped == null
    ? `Could not read a stamped source commit from ${d.url} (fetch failed, or no "Built from <sha>" ` +
      `link matching /commit\\/[0-9a-f]{40}/ was found). Do not assume "sha" is safe to bind instead — ` +
      `open the URL yourself and confirm the commit before calling release, which will refuse the same way.`
    : stamped === d.sha
      ? `Matches "sha" — the trigger commit and the page's stamped source commit are the same here. ` +
        `Either value is safe to bind as release.commit.`
      : `Differs from "sha" (${d.sha.slice(0, 7)}): the page was built from ${stamped.slice(0, 7)}, not ` +
        `the trigger commit. THIS is the value release.commit must carry — the receipt binds what the ` +
        `released page displays, and release will refuse "${d.sha.slice(0, 7)}" as a mismatch.`;
  return { ...d, stampedSourceCommit: stamped, stampedSourceCommitNote: note };
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
  'Get one deployment by id, including its URL, current state, and `stampedSourceCommit` — the source commit ' +
    'its built page actually displays (fetched and read from the page\'s "Built from" link). Use ' +
    '`stampedSourceCommit`, not `sha`, as release.commit whenever `stampedSourceCommitNote` says they differ: ' +
    'the receipt must bind the commit the released page displays, and `sha` is only the trigger ref that ' +
    'started the build, which can be a build-artifact commit.',
  {
    repo: z.string().describe('Repository as owner/name'),
    deployment_id: z.number().describe('Deployment id from list_deployments'),
  },
  async ({ repo, deployment_id }) => {
    try {
      const deployment = await gh.getDeployment(repo, deployment_id);
      return ok(JSON.stringify(await withStampedCommit(deployment), null, 2));
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
    'Get that value from get_deployment\'s `stampedSourceCommit`, not from a repo\'s HEAD/trigger sha — when the head is a build-artifact commit the two diverge, and this tool independently fetches deployment_url and refuses (fail-closed) if the commit you supplied is not what the page displays.',
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
      // exists — it cannot run earlier, since it needs a live deployment_url
      // to fetch — so its job is narrow but load-bearing: stop a receipt that
      // is already minted from going live bound to the wrong commit. A
      // receipt for `commit` is worthless if the page it activates displays
      // a different one; the public receipt lookup checks the page, not the
      // dispatch input.
      const check = await gh.checkStampedCommit(deployment_url, commit);
      if (check.status === 'unconfirmed') {
        return fail(new Error(
          `Refusing to release: could not confirm what commit ${deployment_url} was built from. ` +
          `Checked: fetched the page over HTTPS and looked for a "Built from <sha>" link matching ` +
          `/commit\\/[0-9a-f]{40}/ in its HTML — the fetch failed, timed out, or no such link was found. ` +
          `An unreadable page is not evidence that "${commit}" is the right commit to bind; the absence ` +
          `of a stamped value must not pass unchecked. Open ${deployment_url} yourself and confirm the ` +
          `commit before retrying.`,
        ));
      }
      if (check.status === 'mismatch') {
        return fail(new Error(
          `Refusing to release: ${deployment_url} was built from ${check.stamped}, but commit "${commit}" ` +
          `was supplied to bind the receipt. The receipt would certify a commit the released page does not ` +
          `display — the released page's "Built from" link shows ${check.stamped}, not ${commit}. Use ` +
          `${check.stamped} as the "commit" argument (get_deployment reports it as stampedSourceCommit) and ` +
          `retry; nothing was dispatched.`,
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
