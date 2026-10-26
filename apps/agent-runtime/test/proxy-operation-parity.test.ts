import { describe, expect, it } from 'vitest';
// The agent runtime ships without the contracts package, so it keeps its own copy of the proxy
// operation list. This test is the guard that keeps the two copies identical.
import { AgentProxyOperationSchema as ContractProxyOperationSchema } from '../../../packages/contracts/src/runner-api.js';
import { AgentProxyOperationSchema as RuntimeProxyOperationSchema } from '../src/protocol-schemas.js';
import { ProxyToolBroker } from '../src/proxy-tools.js';
import { createRedactor } from '../src/redaction.js';

describe('agent proxy operation parity', () => {
  it('keeps the runtime proxy operation list identical to the runner contract, in order', () => {
    expect(RuntimeProxyOperationSchema.options).toEqual(ContractProxyOperationSchema.options);
  });

  it('defines a strict tool for every proxy operation', () => {
    const broker = new ProxyToolBroker(() => undefined, createRedactor([]), 1_048_576);
    const definitions = broker.createDefinitions(RuntimeProxyOperationSchema.options);
    expect(definitions.map((definition) => definition.name)).toEqual(RuntimeProxyOperationSchema.options);
    for (const definition of definitions) {
      expect((definition.parameters as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
  });
});
