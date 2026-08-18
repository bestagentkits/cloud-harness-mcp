import type { ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';

if (process.env.FAKE_PROVIDER_TEST_ONLY !== 'true') throw new Error('fake provider requires explicit test-only mode');
const key = await readFile(process.env.FAKE_PROVIDER_TLS_KEY_FILE ?? '/run/model-gateway-test-tls/server-key.pem');
const expectedCredential = (await readFile(process.env.FAKE_PROVIDER_CREDENTIAL_FILE ?? '/run/model-gateway-test-secrets/provider-api-key', 'utf8')).trim();
const cert = await readFile(process.env.FAKE_PROVIDER_TLS_CERT_FILE ?? '/run/model-gateway-test-tls/server-cert.pem');
const port = Number(process.env.FAKE_PROVIDER_PORT ?? '3443');

const server = createServer({ key, cert }, (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || request.headers.authorization !== `Bearer ${expectedCredential}`) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not found"}');
    return;
  }
  let bytes = 0;
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > 1_048_576) {
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body must be an object');
      body = parsed as Record<string, unknown>;
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"error":"invalid request"}');
      return;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const toolResults = messages.filter(isToolResult);
    const hold = JSON.stringify(messages).includes('[FAKE_PROVIDER_HOLD]');
    const phase = hold ? 'hold' : toolResults.length === 0 ? 'write' : toolResults.length === 1 ? 'edit' : 'complete';
    process.stdout.write(`${JSON.stringify({ event: 'fake-provider-request', phase })}\n`);
    if (hold) {
      response.once('close', () => {
        process.stdout.write(`${JSON.stringify({ event: 'fake-provider-close', phase })}\n`);
      });
    }
    const send = () => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-provider-secret': 'must-not-cross-gateway' });
      if (phase === 'write') {
        streamToolCall(response, 'call_fake_write', 'files_write', {
          path: 'pi-agent-proof.txt',
          content: 'created by actual Pi agent\n'
        });
      } else if (phase === 'edit') {
        streamToolCall(response, 'call_fake_edit', 'files_apply_patch', {
          path: 'pi-agent-proof.txt',
          oldText: 'created by actual Pi agent\n',
          newText: 'edited by actual Pi agent through the proxy\n'
        });
      } else {
        streamCompletion(response);
      }
    };
    // Keep a real upstream request open so the E2E can prove cooperative cancellation and drain.
    if (hold) setTimeout(send, 30_000);
    else send();
  });
});

function streamToolCall(
  response: ServerResponse,
  id: string,
  name: string,
  argumentsValue: Record<string, unknown>
): void {
  const chunk = {
    id: 'chatcmpl-fake-tool',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake-model',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(argumentsValue) }
        }]
      },
      finish_reason: null
    }]
  };
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.write(`data: ${JSON.stringify({
    ...chunk,
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
  })}\n\n`);
  response.end('data: [DONE]\n\n');
}

function streamCompletion(response: ServerResponse): void {
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl-fake-complete',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'fake provider completed the deterministic edit' }, finish_reason: null }]
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl-fake-complete',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
  })}\n\n`);
  response.end('data: [DONE]\n\n');
}

function isToolResult(message: unknown): boolean {
  return message !== null
    && typeof message === 'object'
    && 'role' in message
    && message.role === 'tool';
}

server.listen(port, '0.0.0.0');
