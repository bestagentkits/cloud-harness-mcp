import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSessionEvent
} from '@earendil-works/pi-coding-agent';
import { ControlledResourceLoader } from './controlled-resources.js';
import type { ProxyToolBroker } from './proxy-tools.js';
import type { StartRecord, Usage } from './protocol-schemas.js';

const GATEWAY_PROVIDER_ID = 'cloud-harness-gateway';
const RUNTIME_CWD = '/runtime';

export interface SessionStatsLike {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
}

export interface AgentSessionLike {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  readonly messages: ReadonlyArray<{
    role: string;
    stopReason?: string;
    errorMessage?: string;
  }>;
  dispose(): void;
  getActiveToolNames(): string[];
  getAllTools(): Array<{ name: string }>;
  getSessionStats(): SessionStatsLike;
}

export type AgentSessionFactory = (
  start: StartRecord,
  broker: ProxyToolBroker
) => Promise<AgentSessionLike>;

export function usageFromSession(session: AgentSessionLike): Usage {
  const stats = session.getSessionStats();
  return {
    input: stats.tokens.input,
    output: stats.tokens.output,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    total: stats.tokens.total,
    cost: stats.cost
  };
}

export function assertExactTools(session: AgentSessionLike, expectedNames: readonly string[]): void {
  const expected = [...expectedNames].sort();
  const active = session.getActiveToolNames().sort();
  const registered = session.getAllTools().map((tool) => tool.name).sort();
  if (JSON.stringify(active) !== JSON.stringify(expected)) {
    throw new Error('Pi active tool set does not match the proxy allowlist');
  }
  if (JSON.stringify(registered) !== JSON.stringify(expected)) {
    throw new Error('Pi registered tool set contains a non-proxy tool');
  }
}

export function createPiSessionFactory(gatewayBaseUrl: string): AgentSessionFactory {
  const parsedGatewayUrl = new URL(gatewayBaseUrl);
  if (!['http:', 'https:'].includes(parsedGatewayUrl.protocol)) {
    throw new Error('model gateway URL must use HTTP or HTTPS');
  }
  if (parsedGatewayUrl.username || parsedGatewayUrl.password || parsedGatewayUrl.search || parsedGatewayUrl.hash) {
    throw new Error('model gateway URL cannot contain credentials, query parameters, or fragments');
  }
  return async (start, broker) => {
    const credentials = new InMemoryCredentialStore();
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false
    });
    modelRuntime.registerProvider(GATEWAY_PROVIDER_ID, {
      name: 'Cloud Harness model gateway',
      baseUrl: parsedGatewayUrl.toString().replace(/\/$/u, ''),
      api: start.model.api,
      headers: {
        'X-Agent-ID': start.agentId,
        'X-Model-Profile': start.gateway.profile
      },
      models: [{
        id: start.model.id,
        name: start.model.name,
        reasoning: start.model.reasoning,
        input: ['text'],
        cost: start.model.cost,
        contextWindow: start.model.contextWindow,
        maxTokens: start.model.maxTokens
      }]
    });
    await modelRuntime.setRuntimeApiKey(GATEWAY_PROVIDER_ID, start.gateway.lease);
    const model = modelRuntime.getModel(GATEWAY_PROVIDER_ID, start.model.id);
    if (!model) throw new Error('configured gateway model is unavailable');

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: {
        enabled: false,
        maxRetries: 0,
        provider: { timeoutMs: start.limits.deadlineMs, maxRetries: 0, maxRetryDelayMs: 0 }
      },
      images: { autoResize: false, blockImages: true },
      enableSkillCommands: false,
      enableInstallTelemetry: false,
      enableAnalytics: false,
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
      defaultTools: start.tools
    });
    const resourceLoader = new ControlledResourceLoader();
    const customTools = broker.createDefinitions(start.tools);
    const { session, extensionsResult } = await createAgentSession({
      cwd: RUNTIME_CWD,
      agentDir: RUNTIME_CWD,
      model,
      modelRuntime,
      thinkingLevel: 'off',
      noTools: 'all',
      tools: start.tools,
      customTools,
      resourceLoader,
      sessionManager: SessionManager.inMemory(RUNTIME_CWD),
      settingsManager
    });
    if (extensionsResult.extensions.length !== 0 || extensionsResult.errors.length !== 0) {
      session.dispose();
      throw new Error('controlled Pi session loaded an extension');
    }
    assertExactTools(session, start.tools);
    return session;
  };
}
