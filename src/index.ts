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
  'List deployments and their URLs — the candidates that can be released. Each carries the immutable address of that exact build, which is what a human opens to see what they would be approving.',
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
  'Get one deployment by id, including its URL and current state.',
  {
    repo: z.string().describe('Repository as owner/name'),
    deployment_id: z.number().describe('Deployment id from list_deployments'),
  },
  async ({ repo, deployment_id }) => {
    try {
      return ok(JSON.stringify(await gh.getDeployment(repo, deployment_id), null, 2));
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
  'Make an already-built deployment live for real users. Requires a receipt: the pipeline verifies it before anything is served. Call list_deployments first — you release a specific build, identified by its URL, not a commit.',
  {
    repo: z.string().describe('Repository as owner/name'),
    workflow: z.string().describe('Pipeline that performs the release, e.g. deploy-website.yml'),
    environment: z.string().describe('Target environment, e.g. production'),
    deployment_url: z
      .string()
      .describe('Immutable URL of the build to make live, from list_deployments. This is what the human inspects and what the receipt binds.'),
    branch: z
      .string()
      .optional()
      .describe('Branch the pipeline is dispatched on (default "main"). Nothing is built from it — the release activates deployment_url.'),
    // Declared so the gateway injects the minted receipt. Not supplied by the
    // agent — anything it passes is overwritten by the real one.
    receipt_id: z.string().optional().describe('Injected by the gateway after the receipt is issued'),
  },
  async ({ repo, workflow, environment, deployment_url, branch, receipt_id }) => {
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

      const dispatchedAt = Date.now();
      await gh.dispatchWorkflow({
        repo,
        workflow,
        ref: branch ?? 'main',
        inputs: { deployment_url, receipt_id, environment },
      });

      const run = await gh.findRunSince(repo, workflow, dispatchedAt);
      const where = run ? `\nRun ${run.id}: ${run.html_url}` : '\nRun id not yet visible.';
      return ok(
        `Releasing ${deployment_url} to ${environment}.${where}\n` +
        `The pipeline verifies receipt ${receipt_id} binds this exact build before serving it.`,
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
