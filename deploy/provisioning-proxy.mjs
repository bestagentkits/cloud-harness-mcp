import { connect } from 'node:net';
import http from 'node:http';
import { lookup } from 'node:dns/promises';

const listenHost = process.env.PROVISIONING_PROXY_HOST ?? '0.0.0.0';
const listenPort = Number(process.env.PROVISIONING_PROXY_PORT ?? 3128);

const rawAllowedHosts = (process.env.ALLOWED_HOSTS ?? 'github.com,api.github.com,objects.githubusercontent.com,raw.githubusercontent.com')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

const allowedHostSet = new Set(rawAllowedHosts);

export function isForbiddenIp(ip) {
  if (!ip || typeof ip !== 'string') return true;

  // IPv4-mapped IPv6 address (::ffff:192.0.2.1)
  if (ip.toLowerCase().startsWith('::ffff:')) {
    const v4 = ip.slice(7);
    return isForbiddenIp(v4);
  }

  // IPv4 Checks
  if (ip.includes('.')) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return true;
    const [b0, b1, b2, b3] = parts;

    // 0.0.0.0/8 (Current network)
    if (b0 === 0) return true;
    // 10.0.0.0/8 (Private)
    if (b0 === 10) return true;
    // 100.64.0.0/10 (Carrier-grade NAT)
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
    // 127.0.0.0/8 (Loopback)
    if (b0 === 127) return true;
    // 169.254.0.0/16 (Link-local & Cloud Metadata 169.254.169.254)
    if (b0 === 169 && b1 === 254) return true;
    // 172.16.0.0/12 (Private)
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (b0 === 192 && b1 === 0 && b2 === 0) return true;
    // 192.0.2.0/24 (TEST-NET-1), 198.51.100.0/24 (TEST-NET-2), 203.0.113.0/24 (TEST-NET-3)
    if (b0 === 192 && b1 === 0 && b2 === 2) return true;
    if (b0 === 198 && b1 === 51 && b2 === 100) return true;
    if (b0 === 203 && b1 === 0 && b2 === 113) return true;
    // 192.168.0.0/16 (Private)
    if (b0 === 192 && b1 === 168) return true;
    // 198.18.0.0/15 (Benchmark testing)
    if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
    // 224.0.0.0/4 (Multicast)
    if (b0 >= 224 && b0 <= 239) return true;
    // 240.0.0.0/4 (Reserved / Future use) & 255.255.255.255
    if (b0 >= 240) return true;

    return false;
  }

  // IPv6 Checks
  const normalizedV6 = ip.toLowerCase().trim();
  if (normalizedV6 === '::' || normalizedV6 === '::1' || normalizedV6 === '0:0:0:0:0:0:0:1') return true;
  // fc00::/7 (Unique Local Address)
  if (normalizedV6.startsWith('fc') || normalizedV6.startsWith('fd')) return true;
  // fe80::/10 (Link-Local)
  if (/^fe[89ab]/i.test(normalizedV6)) return true;
  // ff00::/8 (Multicast)
  if (normalizedV6.startsWith('ff')) return true;
  // 2001:db8::/32 (Documentation)
  if (normalizedV6.startsWith('2001:db8:') || normalizedV6.startsWith('2001:0db8:')) return true;

  return false;
}

export async function resolveAndValidateHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return null;
  const cleanHost = hostname.toLowerCase().trim();

  const isExplicitlyAllowed = allowedHostSet.has(cleanHost) || Array.from(allowedHostSet).some((domain) => cleanHost.endsWith(`.${domain}`));
  if (!isExplicitlyAllowed) return null;

  try {
    const addresses = await lookup(cleanHost, { all: true });
    if (!addresses || addresses.length === 0) return null;

    for (const { address } of addresses) {
      if (isForbiddenIp(address)) {
        return null;
      }
    }

    return {
      hostname: cleanHost,
      validatedIp: addresses[0].address
    };
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
    const host = parsedUrl.hostname;
    const port = Number(parsedUrl.port) || 80;

    const validated = await resolveAndValidateHost(host);
    if (!validated) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: destination host is not allowlisted or resolves to a forbidden IP address\n');
      return;
    }

    const upstream = connect({ host: validated.validatedIp, port }, () => {
      res.writeHead(200);
      req.pipe(upstream).pipe(res);
    });

    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Bad Gateway\n');
      }
    });
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request\n');
  }
});

server.on('connect', async (req, clientSocket, head) => {
  try {
    const [host, portStr] = (req.url ?? '').split(':');
    const port = Number(portStr) || 443;

    if (port !== 443) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nForbidden: only port 443 is permitted for CONNECT\r\n');
      clientSocket.destroy();
      return;
    }

    const validated = await resolveAndValidateHost(host);
    if (!validated) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nForbidden: destination is not allowlisted or resolves to forbidden IP\r\n');
      clientSocket.destroy();
      return;
    }

    const upstreamSocket = connect({ host: validated.validatedIp, port: 443 }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) {
        upstreamSocket.write(head);
      }
      clientSocket.pipe(upstreamSocket).pipe(clientSocket);
    });

    upstreamSocket.on('error', () => {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    });
    clientSocket.on('error', () => {
      upstreamSocket.destroy();
    });
  } catch {
    clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    clientSocket.destroy();
  }
});

server.listen(listenPort, listenHost, () => {
  process.stdout.write(`provisioning proxy listening on ${listenHost}:${listenPort}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
