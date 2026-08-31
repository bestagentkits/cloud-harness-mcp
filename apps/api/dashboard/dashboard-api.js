let csrfToken;

export async function bootstrapSession() {
  const response = await fetch('/dashboard/api/v1/session', { credentials: 'same-origin' });
  if (!response.ok) throw await problem(response);
  csrfToken = (await response.json()).csrfToken;
}

export async function api(path, options = {}) {
  const method = options.method ?? 'GET';
  const mutation = !['GET', 'HEAD'].includes(method);
  if (mutation && !csrfToken) await bootstrapSession();
  const response = await fetch(`/dashboard/api/v1${path}`, {
    ...options,
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

export const listModelProfiles = () => api('/agent-model-profiles');
export const createModelProfile = (payload) => api('/agent-model-profiles', { method: 'POST', body: JSON.stringify(payload) });
export const updateModelProfile = (id, payload) => api(`/agent-model-profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
export const activateModelProfile = (id, expectedGeneration) => api(`/agent-model-profiles/${encodeURIComponent(id)}/activate`, { method: 'POST', body: JSON.stringify({ expectedGeneration }) });
export const disableModelProfile = (id, expectedGeneration) => api(`/agent-model-profiles/${encodeURIComponent(id)}/disable`, { method: 'POST', body: JSON.stringify({ expectedGeneration }) });
export const deleteModelProfile = (id, expectedGeneration) => api(`/agent-model-profiles/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ expectedGeneration }) });
export const getModelConfigStatus = () => api('/agent-model-config-status');

async function problem(response) {
  let body = {};
  try { body = await response.json(); } catch { /* sanitized fallback */ }
  return Object.assign(new Error(body.message ?? 'The request could not be completed.'), { status: response.status, code: body.error });
}
