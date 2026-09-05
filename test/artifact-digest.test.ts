/**
 * The artifact digest — doc/deploy-digest-binding-proposal.md §3.1.
 *
 * Three implementations must agree byte-for-byte: the build workflow (shell),
 * the release workflow (shell), and this reference (Node). The fixture digest
 * below was produced by the shell procedure the workflows run:
 *
 *   find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum \
 *     | sed 's|  \./|  |' | sha256sum
 *
 * If this test ever disagrees with that command, the workflows are what a
 * release trusts — fix the reference, not the pin.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { manifestDigestOfDir, parseArtifactTrailers } from '../src/github-api.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/artifact', import.meta.url));
const SHELL_DIGEST = 'sha256:8ec3755f2c3c7ff9a25bf8310d4ca5cd68997d768faaa9a1ce96d2cb60ff6aef';

describe('manifestDigestOfDir — parity with the shell procedure', () => {
  it('produces the digest the build and release workflows compute', () => {
    expect(manifestDigestOfDir(FIXTURE).digest).toBe(SHELL_DIGEST);
  });

  it('sorts paths bytewise, so ".well-known/" precedes "assets/" and an empty file counts', () => {
    const { manifest } = manifestDigestOfDir(FIXTURE);
    expect(manifest.split('\n').filter(Boolean).map(l => l.split('  ')[1])).toEqual([
      '.well-known/x.txt',
      'assets/a.css',
      'empty.txt',
      'index.html',
    ]);
    // sha256 of zero bytes — the well-known constant; an empty file is a file.
    expect(manifest).toContain('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  empty.txt');
  });
});

describe('parseArtifactTrailers', () => {
  const MSG = [
    'build: website artifact from 7909995',
    '',
    'Built by CI from the source in this commit. Vercel serves these bytes',
    'directly, so this is the artifact a release makes live.',
    '',
    'Artifact-Digest: sha256:8ec3755f2c3c7ff9a25bf8310d4ca5cd68997d768faaa9a1ce96d2cb60ff6aef',
    'Artifact-Root: website/dist',
    'Source-Commit: 790999577f81cf11963a56c1e5c51e3b1b08ce97',
  ].join('\n');

  it('reads the three trailers the build writes', () => {
    expect(parseArtifactTrailers(MSG)).toEqual({
      artifactDigest: SHELL_DIGEST,
      artifactRoot: 'website/dist',
      sourceCommit: '790999577f81cf11963a56c1e5c51e3b1b08ce97',
    });
  });

  it('a commit without trailers (pre-attestation builds) yields nulls, never a guess', () => {
    expect(parseArtifactTrailers('build: website artifact from 7909995\n\nBuilt by CI.')).toEqual({
      artifactDigest: null,
      artifactRoot: null,
      sourceCommit: null,
    });
  });

  it('a malformed digest is treated as absent', () => {
    expect(parseArtifactTrailers('x\n\nArtifact-Digest: 8ec3755f\n').artifactDigest).toBeNull();
    expect(parseArtifactTrailers('x\n\nArtifact-Digest: sha1:abcd\n').artifactDigest).toBeNull();
  });
});
