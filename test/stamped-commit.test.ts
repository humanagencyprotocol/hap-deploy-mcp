/**
 * Fail-closed source-commit guard — the check `release` runs against the
 * live deployment_url before dispatching (2026-08-12 incident: a receipt
 * was bound to a trigger sha the released page never displayed, and the
 * public receipt lookup correctly reported nothing found).
 *
 * All three tests mock `fetch` at the HTTP boundary — no real network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractStampedCommit, checkStampedCommit } from '../src/github-api.js';

const SOURCE_SHA = '046c198000000000000000000000000000000000'.slice(0, 40); // the sha the page stamps
const TRIGGER_SHA = '6af114b000000000000000000000000000000000'.slice(0, 40); // the mismatched sha from the incident

function htmlWithFooter(sha: string): string {
  return `<html><body><footer>Built from <a href="https://github.com/o/r/commit/${sha}">${sha.slice(0, 7)}</a></footer></body></html>`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractStampedCommit', () => {
  it('reads the sha out of a "Built from" commit link', () => {
    expect(extractStampedCommit(htmlWithFooter(SOURCE_SHA))).toBe(SOURCE_SHA);
  });

  it('returns null when the page has no matching commit link', () => {
    expect(extractStampedCommit('<html><body>no footer here</body></html>')).toBeNull();
  });

  it('takes the FIRST match when a page has more than one commit link', () => {
    const html = `${htmlWithFooter(SOURCE_SHA)}<a href="/o/r/commit/${TRIGGER_SHA}">other</a>`;
    expect(extractStampedCommit(html)).toBe(SOURCE_SHA);
  });
});

describe('checkStampedCommit — the three release-time guard branches', () => {
  it('match: page stamps the same commit that was supplied', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => htmlWithFooter(SOURCE_SHA),
    }));

    const result = await checkStampedCommit('https://example.com/deploy', SOURCE_SHA);
    expect(result).toEqual({ status: 'match', stamped: SOURCE_SHA });
  });

  it('match: commit comparison is case-insensitive', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => htmlWithFooter(SOURCE_SHA),
    }));

    const result = await checkStampedCommit('https://example.com/deploy', SOURCE_SHA.toUpperCase());
    expect(result.status).toBe('match');
  });

  it('mismatch: page stamps a different commit than was supplied (the 2026-08-12 case)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => htmlWithFooter(SOURCE_SHA),
    }));

    const result = await checkStampedCommit('https://example.com/deploy', TRIGGER_SHA);
    expect(result).toEqual({ status: 'mismatch', stamped: SOURCE_SHA });
  });

  it('unconfirmed: fetch throws (network error / timeout)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const result = await checkStampedCommit('https://example.com/deploy', SOURCE_SHA);
    expect(result).toEqual({ status: 'unconfirmed' });
  });

  it('unconfirmed: non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, text: async () => '' }));

    const result = await checkStampedCommit('https://example.com/deploy', SOURCE_SHA);
    expect(result).toEqual({ status: 'unconfirmed' });
  });

  it('unconfirmed: page fetched fine but has no "Built from" commit link — absence must not pass unchecked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<html><body>nothing to see here</body></html>',
    }));

    const result = await checkStampedCommit('https://example.com/deploy', SOURCE_SHA);
    expect(result).toEqual({ status: 'unconfirmed' });
  });
});
