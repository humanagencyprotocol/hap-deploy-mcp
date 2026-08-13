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
  // Tolerance for clock skew between this machine and GitHub's timestamps.
  // Without it a run created microseconds before our local `Date.now()` reading
  // is missed entirely.
  const SKEW_MS = 5_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await listRuns(repo, workflow, 10);
    const candidates = runs.filter(
      r => r.event === 'workflow_dispatch' && Date.parse(r.created_at) >= sinceMs - SKEW_MS,
    );
    // Exactly one candidate is an identification. Two or more is a coincidence
    // — a concurrent dispatch of the same workflow — and picking the first
    // would silently attribute someone else's run to this receipt. Report
    // nothing rather than something wrong.
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) return null;
    await new Promise(r => setTimeout(r, 2_000));
  }
  return null;
}

// ─── Deployments (the artifacts that can be released) ───────────────────────

export interface DeploymentRecord {
  id: number;
  sha: string;
  environment: string;
  created_at: string;
  /** The immutable per-deployment URL. Null until the host reports success. */
  url: string | null;
  state: string | null;
}

/**
 * List deployments with their current status.
 *
 * Reads GitHub's Deployments API rather than workflow runs, because the thing
 * being released is an ARTIFACT, not a pipeline execution. Hosts with a GitHub
 * integration (Vercel, Netlify, Render) publish a deployment status carrying
 * `environment_url` — the immutable per-deployment address.
 *
 * That one value is doing three jobs: it identifies the artifact, it is what a
 * human opens to inspect what they are approving, and it is what the host's
 * promote command accepts. It also means this connector never needs the host's
 * credentials — GitHub already knows.
 *
 * Costs one status request per deployment; the list is deliberately short.
 */
export async function listDeployments(
  repo: string,
  environment?: string,
  limit = 10,
): Promise<DeploymentRecord[]> {
  const qs = new URLSearchParams({ per_page: String(limit) });
  if (environment) qs.set('environment', environment);
  const raw = await gh<Array<{ id: number; sha: string; environment: string; created_at: string }>>(
    `/repos/${assertRepo(repo)}/deployments?${qs}`,
  );
  return Promise.all(raw.map(async d => {
    const statuses = await gh<Array<{ state: string; environment_url?: string }>>(
      `/repos/${assertRepo(repo)}/deployments/${d.id}/statuses?per_page=1`,
    ).catch(() => []);
    const latest = statuses[0];
    return {
      id: d.id,
      sha: d.sha,
      environment: d.environment,
      created_at: d.created_at,
      url: latest?.environment_url ?? null,
      state: latest?.state ?? null,
    };
  }));
}

export async function getDeployment(repo: string, id: number): Promise<DeploymentRecord> {
  const d = await gh<{ id: number; sha: string; environment: string; created_at: string }>(
    `/repos/${assertRepo(repo)}/deployments/${id}`,
  );
  const statuses = await gh<Array<{ state: string; environment_url?: string }>>(
    `/repos/${assertRepo(repo)}/deployments/${id}/statuses?per_page=1`,
  ).catch(() => []);
  return {
    id: d.id, sha: d.sha, environment: d.environment, created_at: d.created_at,
    url: statuses[0]?.environment_url ?? null, state: statuses[0]?.state ?? null,
  };
}

// ─── Stamped source commit (what the built page actually displays) ─────────

const STAMPED_COMMIT_RE = /commit\/([0-9a-f]{40})/;
const STAMPED_COMMIT_FETCH_TIMEOUT_MS = 5_000;

/**
 * Pull the source commit out of a built page's "Built from <sha>" footer
 * link. CI pipelines (this repo's `build-website.yml` included) stamp
 * VERCEL_GIT_COMMIT_SHA — the last non-build commit — into that link when
 * the page is built. It is what a reader sees and what a public receipt
 * lookup checks against.
 *
 * That stamped value is NOT always the same as a deployment's `sha` field
 * (GitHub's Deployments API reports the ref that triggered the build). When
 * the repo head is a build-artifact commit — a dist-only merge tip, say —
 * the trigger sha and the source sha diverge, and a receipt bound to the
 * trigger sha certifies a commit the page never displays. Exported
 * separately from {@link fetchStampedCommit} so extraction can be unit
 * tested against fixed HTML, with no network involved.
 */
export function extractStampedCommit(html: string): string | null {
  const m = STAMPED_COMMIT_RE.exec(html);
  return m ? m[1] : null;
}

/**
 * Fetch a deployment URL and read the commit its "Built from" footer
 * displays.
 *
 * Returns null on ANY failure to obtain a trustworthy value — network
 * error, timeout, non-2xx response, or a page with no matching link.
 * Callers must treat null as "unknown, could not confirm", never as a
 * silent pass: the whole point of this check is that absence of the value
 * must not let a release through unchecked.
 */
export async function fetchStampedCommit(
  url: string,
  timeoutMs = STAMPED_COMMIT_FETCH_TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const html = await res.text();
    return extractStampedCommit(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type StampedCommitCheck =
  | { status: 'match'; stamped: string }
  | { status: 'mismatch'; stamped: string }
  // Fetch failed/timed out, or the page had no matching "Built from" link.
  // Kept as one outcome, not two, because `release` treats both the same
  // way: refuse. Absence of the value must not pass unchecked.
  | { status: 'unconfirmed' };

/**
 * The fail-closed guard `release` runs before dispatching: does the page at
 * `url` display `expectedCommit`?
 *
 * Pulled out of the tool handler so it is a plain async function — testable
 * against a mocked `fetch` without pulling in the MCP server (which starts
 * a stdio transport as a side effect of module load).
 */
export async function checkStampedCommit(
  url: string,
  expectedCommit: string,
  timeoutMs?: number,
): Promise<StampedCommitCheck> {
  const stamped = await fetchStampedCommit(url, timeoutMs);
  if (stamped == null) return { status: 'unconfirmed' };
  return stamped.toLowerCase() === expectedCommit.toLowerCase()
    ? { status: 'match', stamped }
    : { status: 'mismatch', stamped };
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
