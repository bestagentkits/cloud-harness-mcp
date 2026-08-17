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

async function problem(response) {
  let body = {};
  try { body = await response.json(); } catch { /* sanitized fallback */ }
  return Object.assign(new Error(body.message ?? 'The request could not be completed.'), { status: response.status, code: body.error });
}
