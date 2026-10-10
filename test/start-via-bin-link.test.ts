/**
 * The gateway starts a connector through its package bin — a SYMLINK in
 * node_modules/.bin — so process.argv[1] is the link, not dist/index.js.
 * 0.5.0 compared import.meta.url against `file://${argv[1]}`, never matched
 * under a link, and exited silently: "Connection closed" in the gateway, and
 * the Deploy connector could not start at all (found 2026-10-10).
 *
 * This starts the BUILT program exactly that way and requires a handshake.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(import.meta.dirname, '..', 'dist', 'index.js');

function handshake(cmd: string): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, [], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GITHUB_TOKEN: 'x' } });
    let out = '';
    const timer = setTimeout(() => { child.kill(); rej(new Error(`no answer; stdout=${out}`)); }, 10_000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('"id":1')) { clearTimeout(timer); child.kill(); res(out); }
    });
    child.on('exit', (code) => { clearTimeout(timer); rej(new Error(`exited (${code}) before answering; stdout=${out}`)); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
  });
}

describe('starts when launched through a bin symlink (how the gateway runs it)', () => {
  beforeAll(() => {
    if (!existsSync(DIST)) execFileSync('npm', ['run', 'build'], { cwd: resolve(import.meta.dirname, '..'), stdio: 'ignore' });
  }, 120_000);

  it('answers initialize via node_modules/.bin-style link', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-mcp-bin-'));
    const link = join(dir, 'deploy-mcp');
    symlinkSync(DIST, link);
    const out = await handshake(link);
    expect(out).toContain('"serverInfo"');
  }, 20_000);

  it('still answers when run directly', async () => {
    const out = await handshake(DIST);
    expect(out).toContain('"serverInfo"');
  }, 20_000);
});
