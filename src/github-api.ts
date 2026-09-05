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

// ─── Artifact provenance from git (no page fetch, no host credentials) ──────

/**
 * What a release actually binds should be the bytes that go live, and bytes
 * have a digest. For a repository whose served artifact is COMMITTED (the
 * host runs no build — it serves a checked-in directory as-is), that digest
 * already exists: the git tree sha of that directory at the deployed commit.
 * It is a Merkle hash over exactly the served files, computable from the
 * GitHub API alone.
 *
 * The same walk yields the SOURCE commit — the last commit on the deployed
 * commit's history that touched anything outside the artifact directory —
 * by the very rule the build workflow uses to stamp the page
 * (`git log -1 -- . ':(exclude)<artifact>'`). Deriving it here means the
 * release guard no longer depends on fetching the page: the footer becomes
 * a cross-check when reachable, not the gate.
 *
 * Without an artifact path the host builds from the commit itself; the only
 * digest available is the commit's root tree — a digest of the SOURCE, not
 * of the served bytes. `digestKind` says which, so nobody reads one as the
 * other.
 */

export interface ArtifactProvenance {
  /** Git tree sha — see `digestKind` for what it is a digest OF. */
  artifactDigest: string;
  /**
   * `artifact-tree`: tree of the committed artifact directory — a digest of
   * the served bytes. `source-tree`: root tree of the deployed commit — a
   * digest of the source the host built from, not of what it serves.
   */
  digestKind: 'artifact-tree' | 'source-tree';
  /** The artifact directory, or null when the host builds. */
  artifactPath: string | null;
  /** The commit the artifact was built from, derived from git history. */
  sourceCommit: string;
  /** The commit that triggered the deployment (the artifact commit, when one exists). */
  triggerCommit: string;
}

/**
 * HAP_DEPLOY_ARTIFACT_PATH — repository-relative directory the host serves
 * as-is (e.g. `website/dist`). Unset means the host builds from source.
 * Normalised: no leading `./` or `/`, no trailing `/`.
 */
export function artifactPathFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.HAP_DEPLOY_ARTIFACT_PATH?.trim();
  if (!raw) return null;
  const norm = raw.replace(/^(\.\/|\/)+/, '').replace(/\/+$/, '');
  if (!norm || norm.includes('..')) {
    throw new Error(`HAP_DEPLOY_ARTIFACT_PATH "${raw}" is not a plain repository-relative directory`);
  }
  return norm;
}

/** True when `filename` lies outside the artifact directory. Exported for tests. */
export function isOutsideArtifact(filename: string, artifactPath: string): boolean {
  return filename !== artifactPath && !filename.startsWith(artifactPath + '/');
}

/**
 * The build workflow's rule, applied to a commit list newest-first: the
 * first commit that touched anything outside the artifact directory is the
 * source. Returns null if none of the given commits qualifies. Exported so
 * the rule is unit-tested against fixed data, no network.
 */
export function firstSourceCommit(
  commits: Array<{ sha: string; files: Array<{ filename: string }> }>,
  artifactPath: string,
): string | null {
  for (const c of commits) {
    if (c.files.some(f => isOutsideArtifact(f.filename, artifactPath))) return c.sha;
  }
  return null;
}

/** How many commits back to look for the source. Artifact commits stack only on manual reruns. */
const SOURCE_SEARCH_DEPTH = 30;

export async function resolveArtifact(
  repo: string,
  sha: string,
  artifactPath: string | null,
): Promise<ArtifactProvenance> {
  const r = assertRepo(repo);
  const commit = await gh<{ sha: string; tree: { sha: string } }>(`/repos/${r}/git/commits/${sha}`);

  if (!artifactPath) {
    return {
      artifactDigest: commit.tree.sha,
      digestKind: 'source-tree',
      artifactPath: null,
      sourceCommit: commit.sha,
      triggerCommit: commit.sha,
    };
  }

  // Walk the tree down the artifact path. Each hop is one API call; a
  // missing segment means the deployed commit does not contain the artifact.
  let treeSha = commit.tree.sha;
  for (const segment of artifactPath.split('/')) {
    const tree = await gh<{ tree: Array<{ path: string; type: string; sha: string }> }>(
      `/repos/${r}/git/trees/${treeSha}`,
    );
    const entry = tree.tree.find(e => e.path === segment && e.type === 'tree');
    if (!entry) {
      throw new Error(
        `Artifact path "${artifactPath}" not found at ${sha.slice(0, 7)} (missing "${segment}"). ` +
          'Either HAP_DEPLOY_ARTIFACT_PATH is wrong or this commit carries no artifact.',
      );
    }
    treeSha = entry.sha;
  }

  // Source commit: newest-first history from the deployed commit, first one
  // that touched anything outside the artifact directory.
  const history = await gh<Array<{ sha: string }>>(
    `/repos/${r}/commits?sha=${sha}&per_page=${SOURCE_SEARCH_DEPTH}`,
  );
  const withFiles: Array<{ sha: string; files: Array<{ filename: string }> }> = [];
  for (const h of history) {
    const detail = await gh<{ sha: string; files?: Array<{ filename: string }> }>(
      `/repos/${r}/commits/${h.sha}`,
    );
    withFiles.push({ sha: detail.sha, files: detail.files ?? [] });
    // Stop as soon as the rule resolves — usually after one or two commits.
    if (firstSourceCommit(withFiles, artifactPath)) break;
  }
  const sourceCommit = firstSourceCommit(withFiles, artifactPath);
  if (!sourceCommit) {
    throw new Error(
      `Could not find a source commit within ${SOURCE_SEARCH_DEPTH} commits of ${sha.slice(0, 7)}: ` +
        `every one of them touched only "${artifactPath}".`,
    );
  }

  return {
    artifactDigest: treeSha,
    digestKind: 'artifact-tree',
    artifactPath,
    sourceCommit,
    triggerCommit: commit.sha,
  };
}

/** Resolve a deployment URL back to the deployment that owns it. */
export async function findDeploymentByUrl(repo: string, url: string): Promise<DeploymentRecord | null> {
  const wanted = url.replace(/\/+$/, '');
  const candidates = await listDeployments(repo, undefined, 30);
  return candidates.find(d => d.url && d.url.replace(/\/+$/, '') === wanted) ?? null;
}

export type SourceCommitVerdict =
  | { status: 'ok'; pageNote: string }
  | { status: 'mismatch'; derived: string }
  | { status: 'page-contradicts'; stamped: string };

/**
 * The release-time decision, pure so it is tested against fixed inputs.
 *
 * Git is the authority: `supplied` must equal the git-derived source commit.
 * The page's stamped commit, when readable, is a cross-check that may only
 * REFUSE — a page that names a different commit than git does means the
 * footer is lying or the artifact is not what git says, and neither should
 * go live. An unreadable page is not a failure any more: the derivation did
 * not need it.
 */
export function checkSourceCommit(args: {
  supplied: string;
  derived: string;
  stamped: string | null;
}): SourceCommitVerdict {
  const supplied = args.supplied.toLowerCase();
  if (supplied !== args.derived.toLowerCase()) {
    return { status: 'mismatch', derived: args.derived };
  }
  if (args.stamped && args.stamped.toLowerCase() !== supplied) {
    return { status: 'page-contradicts', stamped: args.stamped };
  }
  return {
    status: 'ok',
    pageNote: args.stamped
      ? 'The page footer agrees.'
      : 'The page footer could not be read (private build?); git history is the authority here.',
  };
}
