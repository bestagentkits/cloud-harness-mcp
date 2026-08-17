import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type AuthInfo } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { RunnerPrincipalSelector } from '@cloud-harness/contracts';
import { createCloudHarnessServerFactory } from '../src/mcp-server.js';
import type { RunnerClient } from '../src/runner-client.js';

const authInfo = (subject: string): AuthInfo => {
  const principal: RunnerPrincipalSelector = { kind: 'external', issuer: 'https://team.cloudflareaccess.com', subject };
  return { token: 'opaque', clientId: subject, scopes: [], extra: { principal, externalPrincipal: { issuer: principal.issuer, subject } } };
};

describe('request-local MCP principal context', () => {
  it('does not cross-contaminate concurrent principals', async () => {
    const observed: RunnerPrincipalSelector[] = [];
    const runnerClient = {
      async call(_operation: string, _input: Record<string, unknown>, principal: RunnerPrincipalSelector) {
        await new Promise((resolve) => setTimeout(resolve, principal.kind === 'external' && principal.subject === 'first' ? 10 : 0));
        observed.push(principal);
        return { ok: true as const, message: 'ok', truncated: false };
      }
    } as unknown as RunnerClient;
    const factory = createCloudHarnessServerFactory(runnerClient);
    const [firstClientTransport, firstServerTransport] = InMemoryTransport.createLinkedPair();
    const [secondClientTransport, secondServerTransport] = InMemoryTransport.createLinkedPair();
    const firstServer = factory({ era: 'modern', authInfo: authInfo('first') });
    const secondServer = factory({ era: 'modern', authInfo: authInfo('second') });
    const firstClient = new Client({ name: 'first', version: '1.0.0' });
    const secondClient = new Client({ name: 'second', version: '1.0.0' });
    await Promise.all([
      firstServer.connect(firstServerTransport),
      secondServer.connect(secondServerTransport),
      firstClient.connect(firstClientTransport),
      secondClient.connect(secondClientTransport)
    ]);
    await Promise.all([
      firstClient.callTool({ name: 'workspace_list', arguments: {} }),
      secondClient.callTool({ name: 'workspace_list', arguments: {} })
    ]);
    expect(observed).toHaveLength(2);
    expect(new Set(observed.map((principal) => principal.kind === 'external' ? principal.subject : principal.ownerId))).toEqual(new Set(['first', 'second']));
    await Promise.all([firstClient.close(), secondClient.close(), firstServer.close(), secondServer.close()]);
  });
});
