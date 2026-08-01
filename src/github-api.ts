/**
 * GitHub Actions client — the deployment backend.
 *
 * Token comes from GITHUB_TOKEN and is never accepted as a tool argument: the
 * gateway injects it into this process from its vault, and an agent that could
 * pass its own token would have routed around the whole point.
 */

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';

function getToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');
  return token;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'Content-Type': 'application/json',
  };
}

/** `owner/name`, validated so a malformed value cannot walk the API path. */
function assertRepo(repo: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid repository "${repo}" — expected owner/name`);
  }
  return repo;
}

async function gh<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }
  // 204 No Content: workflow dispatch answers this way.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ─── Commits ─────────────────────────────────────────────────────────────────

export interface ResolvedCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

/**
 * Resolve a branch, tag or SHA to a concrete commit.
 *
 * Exists as its own step because a receipt binds a COMMIT. Authorising "deploy
 * main" would authorise whatever `main` happens to be when the action finally
 * runs, which may not be what the human reviewed.
 */
export async function resolveRef(repo: string, ref: string): Promise<ResolvedCommit> {
  const data = await gh<{
    sha: string;
    commit: { message: string; author: { name: string; date: string } };
  }>(`/repos/${assertRepo(repo)}/commits/${encodeURIComponent(ref)}`);
  return {
    sha: data.sha,
    message: data.commit.message.split('\n')[0],
    author: data.commit.author.name,
    date: data.commit.author.date,
  };
}

// ─── Workflows ───────────────────────────────────────────────────────────────

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  head_sha: string;
  created_at: string;
  html_url: string;
  event: string;
}

/**
 * Dispatch a workflow.
 *
 * NOTE on `ref` vs `sha`: GitHub's dispatch endpoint only accepts a branch or
 * tag as `ref` — you cannot dispatch at an arbitrary commit. The approved
 * commit therefore travels as an INPUT, and the workflow is responsible for
 * checking that commit out. That split is not cosmetic: if the workflow builds
 * `ref` instead of `inputs.sha`, a receipt for one commit can ship another and
 * the receipt still verifies, certifying something false.
 *
 * Answers 204 with no body, so there is no run id to return — see
 * {@link findRunSince}.
 */
export async function dispatchWorkflow(opts: {
  repo: string;
  workflow: string;
  ref: string;
  inputs: Record<string, string>;
}): Promise<void> {
  await gh<void>(
    `/repos/${assertRepo(opts.repo)}/actions/workflows/${encodeURIComponent(opts.workflow)}/dispatches`,
    { method: 'POST', body: JSON.stringify({ ref: opts.ref, inputs: opts.inputs }) },
  );
}

export async function listRuns(repo: string, workflow?: string, limit = 10): Promise<WorkflowRun[]> {
  const path = workflow
    ? `/repos/${assertRepo(repo)}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=${limit}`
    : `/repos/${assertRepo(repo)}/actions/runs?per_page=${limit}`;
  const data = await gh<{ workflow_runs: WorkflowRun[] }>(path);
  return data.workflow_runs ?? [];
}

export async function getRun(repo: string, runId: number): Promise<WorkflowRun> {
  return gh<WorkflowRun>(`/repos/${assertRepo(repo)}/actions/runs/${runId}`);
}

/**
 * Find the run a dispatch just created.
 *
 * GitHub returns no identifier from a dispatch, and offers no correlation id,
 * so matching is by workflow + creation time. Best-effort by construction:
 * returns null rather than guessing, because a wrong run id in a receipt trail
 * is worse than an absent one.
 */
export async function findRunSince(
  repo: string,
  workflow: string,
  sinceMs: number,
  timeoutMs = 12_000,
): Promise<WorkflowRun | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await listRuns(repo, workflow, 10);
    const match = runs.find(
      r => r.event === 'workflow_dispatch' && Date.parse(r.created_at) >= sinceMs - 5_000,
    );
    if (match) return match;
    await new Promise(r => setTimeout(r, 2_000));
  }
  return null;
}

// ─── Environments ────────────────────────────────────────────────────────────

export interface Environment {
  name: string;
}

/**
 * The repository's real environments. Feeds the wizard's picker, so the owner
 * chooses from what exists rather than typing a name the host has never heard
 * of. Names are the host's vocabulary — this repo's is `github-pages`, Vercel's
 * would be `production`/`preview` — which is exactly why the profile does not
 * pin an enum.
 */
export async function listEnvironments(repo: string): Promise<Environment[]> {
  const data = await gh<{ environments?: Environment[] }>(
    `/repos/${assertRepo(repo)}/environments`,
  );
  return data.environments ?? [];
}
