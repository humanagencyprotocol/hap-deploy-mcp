/**
 * Provenance from git — the release guard no longer needs the page.
 *
 * 2026-09-04: the v0.7 website release refused because the staged build sat
 * behind Vercel SSO and the guard could not read its footer. The footer was
 * only ever a self-asserted string; the real evidence — which commit the
 * artifact was built from, and a digest of the served bytes — is in git and
 * reachable through the API without touching the page.
 *
 * Network tests mock `fetch` at the HTTP boundary; the rule itself is tested
 * on fixed data.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  artifactPathFromEnv,
  isOutsideArtifact,
  firstSourceCommit,
  resolveArtifact,
  checkSourceCommit,
} from '../src/github-api.js';

const SRC = '790999577f81cf11963a56c1e5c51e3b1b08ce97';
const ART = 'e06c55166b9804b20bf065f1872c4309382e33ec';
const DIST_TREE = '05efcc067c7b6e7238369cfbe4a04f7285729517';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GITHUB_TOKEN;
});

describe('artifactPathFromEnv', () => {
  it('unset → null (host builds from source)', () => {
    expect(artifactPathFromEnv({})).toBeNull();
    expect(artifactPathFromEnv({ HAP_DEPLOY_ARTIFACT_PATH: '  ' })).toBeNull();
  });
  it('normalises leading ./ and / and trailing /', () => {
    expect(artifactPathFromEnv({ HAP_DEPLOY_ARTIFACT_PATH: './website/dist/' })).toBe('website/dist');
    expect(artifactPathFromEnv({ HAP_DEPLOY_ARTIFACT_PATH: '/website/dist' })).toBe('website/dist');
  });
  it('refuses path traversal', () => {
    expect(() => artifactPathFromEnv({ HAP_DEPLOY_ARTIFACT_PATH: '../dist' })).toThrow();
  });
});

describe('the build workflow rule: first commit touching anything outside the artifact', () => {
  it('isOutsideArtifact', () => {
    expect(isOutsideArtifact('website/dist/index.html', 'website/dist')).toBe(false);
    expect(isOutsideArtifact('website/dist', 'website/dist')).toBe(false);
    expect(isOutsideArtifact('website/distribution/x', 'website/dist')).toBe(true); // prefix ≠ directory
    expect(isOutsideArtifact('content/0.7/protocol.md', 'website/dist')).toBe(true);
  });

  it('skips the artifact commit and lands on its source', () => {
    const commits = [
      { sha: ART, files: [{ filename: 'website/dist/index.html' }, { filename: 'website/dist/a.css' }] },
      { sha: SRC, files: [{ filename: 'content/0.7/review.md' }, { filename: 'website/dist/old.html' }] },
    ];
    expect(firstSourceCommit(commits, 'website/dist')).toBe(SRC);
  });

  it('a source commit deployed directly is its own source', () => {
    expect(firstSourceCommit([{ sha: SRC, files: [{ filename: 'README.md' }] }], 'website/dist')).toBe(SRC);
  });

  it('stacked artifact commits (manual reruns) are all skipped', () => {
    const commits = [
      { sha: 'a'.repeat(40), files: [{ filename: 'website/dist/x' }] },
      { sha: 'b'.repeat(40), files: [{ filename: 'website/dist/y' }] },
      { sha: SRC, files: [{ filename: 'src/x.ts' }] },
    ];
    expect(firstSourceCommit(commits, 'website/dist')).toBe(SRC);
  });

  it('nothing outside the artifact in range → null (caller refuses)', () => {
    expect(firstSourceCommit([{ sha: ART, files: [{ filename: 'website/dist/x' }] }], 'website/dist')).toBeNull();
  });
});

describe('resolveArtifact over the GitHub API', () => {
  function stubApi(routes: Record<string, unknown>) {
    process.env.GITHUB_TOKEN = 't';
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input).replace('https://api.github.com', '');
      calls.push(url);
      const key = Object.keys(routes).find(k => url === k || url.startsWith(k));
      if (!key) return new Response('not found', { status: 404, statusText: 'Not Found' });
      return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    return calls;
  }

  it('committed artifact: digest = tree of the artifact dir, source = derived by the rule', async () => {
    const ROOT = 'root'.padEnd(40, '0');
    const WEBSITE = 'web'.padEnd(40, '0');
    const calls = stubApi({
      [`/repos/o/r/git/commits/${ART}`]: { sha: ART, tree: { sha: ROOT } },
      [`/repos/o/r/git/trees/${ROOT}`]: { tree: [{ path: 'website', type: 'tree', sha: WEBSITE }, { path: 'README.md', type: 'blob', sha: 'x' }] },
      [`/repos/o/r/git/trees/${WEBSITE}`]: { tree: [{ path: 'dist', type: 'tree', sha: DIST_TREE }] },
      [`/repos/o/r/commits?sha=${ART}`]: [{ sha: ART }, { sha: SRC }],
      [`/repos/o/r/commits/${ART}`]: { sha: ART, files: [{ filename: 'website/dist/index.html' }] },
      [`/repos/o/r/commits/${SRC}`]: { sha: SRC, files: [{ filename: 'content/0.7/review.md' }] },
    });

    const p = await resolveArtifact('o/r', ART, 'website/dist');
    expect(p).toEqual({
      artifactDigest: DIST_TREE,
      digestKind: 'artifact-tree',
      artifactPath: 'website/dist',
      sourceCommit: SRC,
      triggerCommit: ART,
    });
    // Stops walking history as soon as the rule resolves.
    expect(calls.filter(c => c.startsWith('/repos/o/r/commits/'))).toHaveLength(2);
  });

  it('no artifact path: digest is the root tree and is labelled source-tree', async () => {
    const ROOT = 'root'.padEnd(40, '0');
    stubApi({ [`/repos/o/r/git/commits/${SRC}`]: { sha: SRC, tree: { sha: ROOT } } });
    const p = await resolveArtifact('o/r', SRC, null);
    expect(p).toEqual({
      artifactDigest: ROOT,
      digestKind: 'source-tree',
      artifactPath: null,
      sourceCommit: SRC,
      triggerCommit: SRC,
    });
  });

  it('artifact path missing at that commit → throws (never a guessed digest)', async () => {
    const ROOT = 'root'.padEnd(40, '0');
    stubApi({
      [`/repos/o/r/git/commits/${ART}`]: { sha: ART, tree: { sha: ROOT } },
      [`/repos/o/r/git/trees/${ROOT}`]: { tree: [{ path: 'README.md', type: 'blob', sha: 'x' }] },
    });
    await expect(resolveArtifact('o/r', ART, 'website/dist')).rejects.toThrow(/not found at/);
  });
});

describe('checkSourceCommit — the release-time decision', () => {
  it('supplied ≠ derived → mismatch, whatever the page says', () => {
    expect(checkSourceCommit({ supplied: ART, derived: SRC, stamped: ART })).toEqual({ status: 'mismatch', derived: SRC });
  });
  it('supplied = derived, page unreadable → ok (git is the authority)', () => {
    const v = checkSourceCommit({ supplied: SRC.toUpperCase(), derived: SRC, stamped: null });
    expect(v.status).toBe('ok');
    if (v.status === 'ok') expect(v.pageNote).toMatch(/could not be read/);
  });
  it('supplied = derived, page agrees → ok', () => {
    expect(checkSourceCommit({ supplied: SRC, derived: SRC, stamped: SRC }).status).toBe('ok');
  });
  it('supplied = derived, page names another commit → page-contradicts (refuse)', () => {
    expect(checkSourceCommit({ supplied: SRC, derived: SRC, stamped: ART })).toEqual({ status: 'page-contradicts', stamped: ART });
  });
});
