import { createServer, connect } from 'node:net';

const listenHost = process.env.INGRESS_HOST ?? '0.0.0.0';
const listenPort = Number(process.env.INGRESS_PORT ?? 3100);
const upstreamHost = process.env.API_UPSTREAM_HOST ?? 'api';
const upstreamPort = Number(process.env.API_UPSTREAM_PORT ?? 3000);

if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65_535) throw new Error('invalid ingress port');
if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65_535) throw new Error('invalid API upstream port');

const server = createServer((downstream) => {
  const upstream = connect({ host: upstreamHost, port: upstreamPort });
  downstream.pipe(upstream).pipe(downstream);
  downstream.on('error', () => upstream.destroy());
  upstream.on('error', () => downstream.destroy());
  downstream.on('close', () => upstream.destroy());
  upstream.on('close', () => downstream.destroy());
});

server.listen(listenPort, listenHost, () => {
  process.stdout.write(`ingress proxy listening on ${listenHost}:${listenPort}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
