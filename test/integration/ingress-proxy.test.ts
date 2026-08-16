import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

let proxy: ChildProcessWithoutNullStreams | undefined;
let upstream: Server | undefined;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server failed to listen');
  return address.port;
}

async function reservePort(): Promise<number> {
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitUntilListening(child: ChildProcessWithoutNullStreams): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('ingress proxy listening')) resolve();
      });
      child.once('exit', (code) => reject(new Error(`ingress proxy exited early with ${code}`)));
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ingress proxy startup timed out')), 5_000))
  ]);
}

afterEach(async () => {
  if (proxy && proxy.exitCode === null) {
    proxy.kill('SIGTERM');
    await new Promise<void>((resolve) => proxy!.once('exit', () => resolve()));
  }
  proxy = undefined;
  if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
  upstream = undefined;
});

describe('credential-free loopback ingress proxy', () => {
  it('forwards HTTP bytes to the private API upstream', async () => {
    let confirmDisconnect: (() => void) | undefined;
    const disconnected = new Promise<void>((resolve) => { confirmDisconnect = resolve; });
    upstream = createServer((request, response) => {
      if (request.url === '/stream') {
        request.socket.once('close', () => confirmDisconnect?.());
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('stream-open');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain', 'x-forwarded-method': request.method });
      response.end('proxy-ok');
    });
    const upstreamPort = await listen(upstream);
    const ingressPort = await reservePort();
    proxy = spawn(process.execPath, ['deploy/ingress-proxy.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        INGRESS_HOST: '127.0.0.1',
        INGRESS_PORT: String(ingressPort),
        API_UPSTREAM_HOST: '127.0.0.1',
        API_UPSTREAM_PORT: String(upstreamPort)
      }
    });
    await waitUntilListening(proxy);

    const response = await fetch(`http://127.0.0.1:${ingressPort}/readyz`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-forwarded-method')).toBe('GET');
    expect(await response.text()).toBe('proxy-ok');

    const controller = new AbortController();
    const streaming = await fetch(`http://127.0.0.1:${ingressPort}/stream`, { signal: controller.signal });
    await streaming.body?.getReader().read();
    controller.abort();
    await Promise.race([
      disconnected,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('downstream cancellation did not close the API connection')), 2_000))
    ]);
  });
});
