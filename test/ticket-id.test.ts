/**
 * HAP v0.7 wire rename — `release`'s gateway-injected argument is `ticket_id`,
 * not `receipt_id`. Connected over an in-memory transport so this exercises
 * the real registered tool (schema and handler), not a re-implementation of
 * it, without starting the real stdio server or hitting the GitHub API.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { server } from '../src/index.js';

let client: Client;

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

afterEach(async () => {
  await client?.close();
});

describe('release — ticket_id replaces receipt_id', () => {
  it("declares ticket_id, not receipt_id, on release's input schema", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    const release = tools.find((t) => t.name === 'release')!;
    const props = (release.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).toHaveProperty('ticket_id');
    expect(props).not.toHaveProperty('receipt_id');
  });

  it('refuses to dispatch when ticket_id is not supplied, naming ticket_id in the refusal', async () => {
    const c = await connect();
    const result = (await c.callTool({
      name: 'release',
      arguments: {
        repo: 'owner/repo',
        workflow: 'deploy.yml',
        environment: 'production',
        deployment_url: 'https://example.com/build',
        commit: 'a'.repeat(40),
      },
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No ticket_id was supplied/);
  });
});
