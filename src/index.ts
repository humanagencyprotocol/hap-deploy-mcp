#!/usr/bin/env node
/**
 * Deploy MCP Server — put software live through GitHub Actions.
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
 *   1. `deploy` declares `receipt_id` in its schema. That declaration is what
 *      makes the gateway inject the receipt after minting it. Remove it and the
 *      pipeline has nothing to verify — the whole chain silently degrades to an
 *      unproven deploy.
 *   2. The token is read from the environment, never from an argument. An agent
 *      that could supply its own credential would have routed around the point.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as gh from './github-api.js';

const server = new McpServer({ name: 'deploy-mcp', version: '0.1.0' });

const fail = (e: unknown) => ({
  content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }],
  isError: true,
});
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });

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
  'List recent workflow runs for a repository.',
  {
    repo: z.string().describe('Repository as owner/name'),
    workflow: z.string().optional().describe('Workflow file name, e.g. deploy.yml'),
    limit: z.number().optional().describe('How many runs to return (default 10)'),
  },
  async ({ repo, workflow, limit }) => {
    try {
      const runs = await gh.listRuns(repo, workflow, limit ?? 10);
      return ok(JSON.stringify(runs, null, 2));
    } catch (e) {
      return fail(e);
    }
  },
);

server.tool(
  'get_deployment',
  'Get one workflow run by id.',
  {
    repo: z.string().describe('Repository as owner/name'),
    run_id: z.number().describe('Workflow run id'),
  },
  async ({ repo, run_id }) => {
    try {
      return ok(JSON.stringify(await gh.getRun(repo, run_id), null, 2));
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
  'deploy',
  'Deploy a specific commit by running a deployment pipeline. Requires a receipt: the pipeline verifies it before anything is released.',
  {
    repo: z.string().describe('Repository as owner/name'),
    workflow: z.string().describe('Workflow file to run, e.g. deploy.yml'),
    environment: z.string().describe('Target environment, e.g. production'),
    sha: z.string().describe('Exact commit to deploy — resolve it with resolve_ref first'),
    branch: z
      .string()
      .optional()
      .describe('Branch the workflow is dispatched on (default "main"). The commit that gets BUILT is `sha`, not this.'),
    // Declared so the gateway injects the minted receipt. Not supplied by the
    // agent — anything it passes is overwritten by the real one.
    receipt_id: z.string().optional().describe('Injected by the gateway after the receipt is issued'),
  },
  async ({ repo, workflow, environment, sha, branch, receipt_id }) => {
    try {
      if (!receipt_id) {
        // Reaching here means the tool ran ungated, or the schema declaration
        // was lost. Refuse rather than deploy something the pipeline will not
        // be able to verify.
        return fail(new Error(
          'No receipt_id was supplied. This tool must be called through a Suveren gateway, ' +
          'which injects the receipt after authorising the deploy. Nothing was dispatched.',
        ));
      }
      if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
        return fail(new Error(`"${sha}" is not a commit SHA. Use resolve_ref to turn a branch into one.`));
      }

      const dispatchedAt = Date.now();
      await gh.dispatchWorkflow({
        repo,
        workflow,
        ref: branch ?? 'main',
        inputs: { sha, receipt_id, environment },
      });

      // Best-effort: GitHub returns no run id from a dispatch.
      const run = await gh.findRunSince(repo, workflow, dispatchedAt);
      return ok(
        run
          ? `Dispatched ${workflow} for ${sha.slice(0, 7)} → ${environment}.\nRun ${run.id}: ${run.html_url}\n` +
            `The pipeline verifies receipt ${receipt_id} before releasing anything.`
          : `Dispatched ${workflow} for ${sha.slice(0, 7)} → ${environment}.\n` +
            `Run id not yet visible — check list_deployments.\n` +
            `The pipeline verifies receipt ${receipt_id} before releasing anything.`,
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
