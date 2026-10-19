let csrfToken;
let navigationSignal;

export function setNavigationSignal(signal) {
  navigationSignal = signal;
}

export async function bootstrapSession() {
  const response = await fetch('/dashboard/api/v1/session', { credentials: 'same-origin' });
  if (!response.ok) throw await problem(response);
  csrfToken = (await response.json()).csrfToken;
}

export async function api(path, options = {}) {
  const method = options.method ?? 'GET';
  const mutation = !['GET', 'HEAD'].includes(method);
  if (mutation && !csrfToken) await bootstrapSession();
  const signal = options.signal ?? (mutation ? undefined : navigationSignal);
  const response = await fetch(`/dashboard/api/v1${path}`, {
    ...options,
    ...(signal ? { signal } : {}),
    credentials: 'same-origin',
    headers: {
      ...(mutation ? { 'content-type': 'application/json', 'x-csrf-token': csrfToken } : {}),
      ...options.headers
    }
  });
  if (!response.ok) {
    if (response.status === 401) csrfToken = undefined;
    throw await problem(response);
  }
  return await response.json();
}
export const listModelCredentials = () => api('/provider-credentials');
export const createModelCredential = (payload) => api('/provider-credentials', { method: 'POST', body: JSON.stringify(payload) });
export const rotateModelCredential = (id, payload) => api(`/provider-credentials/${encodeURIComponent(id)}/rotate`, { method: 'PUT', body: JSON.stringify(payload) });
export const deleteModelCredential = (id, expectedGeneration) => api(`/provider-credentials/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ expectedGeneration }) });

export const listIntegrationCredentials = () => api('/integration-credentials');
export const createIntegrationCredential = (payload) => api('/integration-credentials', { method: 'POST', body: JSON.stringify(payload) });
export const rotateIntegrationCredential = (id, payload) => api(`/integration-credentials/${encodeURIComponent(id)}/rotate`, { method: 'PUT', body: JSON.stringify(payload) });
export const deleteIntegrationCredential = (id, expectedGeneration) => api(`/integration-credentials/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ expectedGeneration }) });
export const getTypesafeStatus = () => api('/typesafe/status');

export const listModelProfiles = () => api('/agent-model-profiles');
export const createModelProfile = (payload) => api('/agent-model-profiles', { method: 'POST', body: JSON.stringify(payload) });
export const updateModelProfile = (id, payload) => api(`/agent-model-profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
export const activateModelProfile = (id, expectedGeneration) => api(`/agent-model-profiles/${encodeURIComponent(id)}/activate`, { method: 'POST', body: JSON.stringify({ expectedGeneration }) });
export const disableModelProfile = (id, expectedGeneration) => api(`/agent-model-profiles/${encodeURIComponent(id)}/disable`, { method: 'POST', body: JSON.stringify({ expectedGeneration }) });
export const deleteModelProfile = (id, expectedGeneration) => api(`/agent-model-profiles/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ expectedGeneration }) });
export const getModelConfigStatus = () => api('/agent-model-config-status');
export const listModelProviders = () => api('/model-providers');
export const searchModelCatalog = ({ provider, credentialId, q, limit } = {}) => {
  const query = new URLSearchParams({ provider: String(provider ?? '') });
  if (credentialId) query.set('credentialId', credentialId);
  if (q) query.set('q', q);
  if (limit) query.set('limit', String(limit));
  return api(`/model-catalog?${query}`);
};
export const refreshModelCatalog = (payload) => api('/model-catalog/refresh', { method: 'POST', body: JSON.stringify(payload) });
export const getModelSpend = () => api('/model-spend');
export const setModelSpendPolicy = (payload) => api('/model-spend/policies', { method: 'PUT', body: JSON.stringify(payload) });
export const deleteModelSpendPolicy = (id, expectedGeneration) => api(`/model-spend/policies/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ expectedGeneration }) });
export const verifyModelConnection = (payload) => api('/model-connection/verify', { method: 'POST', body: JSON.stringify(payload) });
export const listKnowledge = (params = {}) => {
  const query = new URLSearchParams();
  if (params.kind) query.set('kind', params.kind);
  if (params.scope) query.set('scope', params.scope);
  if (params.projectId) query.set('projectId', params.projectId);
  if (params.journalType) query.set('journalType', params.journalType);
  if (params.tags && Array.isArray(params.tags) && params.tags.length) query.set('tags', params.tags.join(','));
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return api(`/knowledge${qs ? `?${qs}` : ''}`);
};
export const getKnowledgeItem = (id) => api(`/knowledge/${encodeURIComponent(id)}`);
export const createKnowledgeItem = (payload) => api('/knowledge', { method: 'POST', body: JSON.stringify(payload) });
export const updateKnowledgeItem = (id, payload) => api(`/knowledge/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) });
export const deleteKnowledgeItem = (id, expectedGeneration) => api(`/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ expectedGeneration }) });
export const searchKnowledge = (payload) => api('/knowledge/search', { method: 'POST', body: JSON.stringify(payload) });
export const getKnowledgeGraph = (params = {}) => {
  const query = new URLSearchParams();
  if (params.rootId) query.set('rootId', params.rootId);
  if (params.depth) query.set('depth', String(params.depth));
  if (params.maxNodes) query.set('maxNodes', String(params.maxNodes));
  if (params.projectId) query.set('projectId', params.projectId);
  const qs = query.toString();
  return api(`/knowledge-graph${qs ? `?${qs}` : ''}`);
};
export const createKnowledgeLink = (payload) => api('/knowledge/links', { method: 'POST', body: JSON.stringify(payload) });
export const deleteKnowledgeLink = (payload) => api('/knowledge/links', { method: 'DELETE', body: JSON.stringify(payload) });

export const listMcpServers = () => api('/mcp-servers');
export const getMcpServer = (serverId) => api(`/mcp-servers/${encodeURIComponent(serverId)}`);
export const createMcpServer = (payload) => api('/mcp-servers', { method: 'POST', body: JSON.stringify(payload) });
export const updateMcpServer = (serverId, payload) => api(`/mcp-servers/${encodeURIComponent(serverId)}`, { method: 'PATCH', body: JSON.stringify(payload) });
export const deleteMcpServer = (serverId, expectedGeneration) => api(`/mcp-servers/${encodeURIComponent(serverId)}`, { method: 'DELETE', body: JSON.stringify({ expectedGeneration }) });
export const setMcpServerEnabled = (serverId, enabled, expectedGeneration) => api(`/mcp-servers/${encodeURIComponent(serverId)}/enabled`, { method: 'POST', body: JSON.stringify({ enabled, expectedGeneration }) });
export const setMcpServerPermissions = (serverId, payload) => api(`/mcp-servers/${encodeURIComponent(serverId)}/permissions`, { method: 'PUT', body: JSON.stringify(payload) });
export const testMcpServer = (serverId) => api(`/mcp-servers/${encodeURIComponent(serverId)}/test`, { method: 'POST' });
export const refreshMcpServerTools = (serverId) => api(`/mcp-servers/${encodeURIComponent(serverId)}/refresh`, { method: 'POST' });
export const getMcpServerOAuth = (serverId) => api(`/mcp-servers/${encodeURIComponent(serverId)}/oauth`);
export const startMcpServerOAuth = (serverId) => api(`/mcp-servers/${encodeURIComponent(serverId)}/oauth/start`, { method: 'POST' });
export const disconnectMcpServerOAuth = (serverId) => api(`/mcp-servers/${encodeURIComponent(serverId)}/oauth/disconnect`, { method: 'POST' });
export const listMcpServerLogs = (serverId, cursor) => api(`/mcp-servers/${encodeURIComponent(serverId)}/logs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
export const getMcpGatewayEndpoint = () => api('/mcp-gateway');
export const listGlobalSecrets = () => api('/secrets');

/** Optional list filters become a query string; empty values are dropped rather than sent as blanks. */
const automationQuery = (params = {}) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  const text = query.toString();
  return text ? `?${text}` : '';
};
const automationPath = (collection, id, suffix = '') => `/automations/${collection}/${encodeURIComponent(id)}${suffix}`;
export const listAutomationConnections = () => api('/automations/connections');
/** `payload` is one `AutomationConnectionCreateInputSchema` variant: `{ provider, name, ...provider fields }`. */
export const createAutomationConnection = (payload) => api('/automations/connections', { method: 'POST', body: JSON.stringify(payload) });
export const updateAutomationConnection = (id, payload) => api(automationPath('connections', id), { method: 'PATCH', body: JSON.stringify(payload) });
export const rotateAutomationConnectionSecret = (id, expectedGeneration) => api(automationPath('connections', id, '/rotate-secret'), { method: 'POST', body: JSON.stringify({ expectedGeneration }) });
export const deleteAutomationConnection = (id, expectedGeneration) => api(automationPath('connections', id), { method: 'DELETE', body: JSON.stringify({ expectedGeneration }) });
export const listAutomationRules = (connectionId) => api(`/automations/rules${automationQuery({ connectionId })}`);
export const createAutomationRule = (payload) => api('/automations/rules', { method: 'POST', body: JSON.stringify(payload) });
export const updateAutomationRule = (id, payload) => api(automationPath('rules', id), { method: 'PATCH', body: JSON.stringify(payload) });
export const deleteAutomationRule = (id, expectedGeneration) => api(automationPath('rules', id), { method: 'DELETE', body: JSON.stringify({ expectedGeneration }) });
export const previewAutomationRule = (id, sample) => api(automationPath('rules', id, '/preview'), { method: 'POST', body: JSON.stringify({ sample }) });
export const listAutomationWorkflows = ({ ruleId, state, publishState, limit } = {}) => api(`/automations/workflows${automationQuery({ ruleId, state, publishState, limit })}`);
export const getAutomationWorkflow = (id, { actionsCursor } = {}) => api(`${automationPath('workflows', id)}${automationQuery({ actionsCursor })}`);
export const cancelAutomationWorkflow = (id, reason) => api(automationPath('workflows', id, '/cancel'), { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) });
export const listAutomationDeliveries = ({ connectionId, state, limit } = {}) => api(`/automations/deliveries${automationQuery({ connectionId, state, limit })}`);
export const replayAutomationDelivery = (id, expectedState) => api(automationPath('deliveries', id, '/replay'), { method: 'POST', body: JSON.stringify(expectedState ? { expectedState } : {}) });
export const getAutomationHealth = (connectionId) => api(`/automations/health${automationQuery({ connectionId })}`);
export const getAutomationMetrics = (windowDays) => api(`/automations/metrics${automationQuery({ windowDays })}`);

async function problem(response) {
  let body = {};
  try { body = await response.json(); } catch { /* sanitized fallback */ }
  return Object.assign(new Error(body.message ?? 'The request could not be completed.'), { status: response.status, code: body.error });
}
