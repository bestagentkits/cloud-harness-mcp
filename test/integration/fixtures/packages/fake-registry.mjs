// A hermetic npm registry, PEP 503 index, and uv Python mirror for the package builder Docker tests.
//
// It runs inside the executor image on an internal Docker network under the alias `fake-registry`, so no
// builder ever reaches the real network or a TLS-intercepting proxy. At startup it packs the fixture npm
// packages with `npm pack`, builds a pure-Python wheel with a minimal STORED zip writer, and then serves:
//   /<name>                       npm packument with http://fake-registry:4873 tarball URLs and sha512 integrity
//   /<name>/-/<file>.tgz          the packed tarballs
//   /simple/ and /simple/<name>/  the PEP 503 index, with sha256 fragments
//   /packages/<wheel>             the wheel
//   /python/<tag>/<file>          the uv Python mirror, read from the host cache mounted at /python-archives
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { crc32 } from 'node:zlib';

const port = 4873;
const origin = `http://fake-registry:${port}`;
const fixtures = process.env.FIXTURES_DIR ?? '/fixtures';
const pythonArchives = process.env.PYTHON_ARCHIVES_DIR ?? '/python-archives';
const work = '/tmp/fake-registry';

/** name -> { versions: { version: manifest }, tarballs: { file: Buffer } } */
const npmPackages = new Map();

function packNpmFixtures() {
  mkdirSync(join(work, 'packs'), { recursive: true });
  for (const entry of readdirSync(join(fixtures, 'npm')).sort()) {
    // Copy first: the fixtures are mounted read-only and npm pack must not write next to them.
    const source = join(work, 'src', entry);
    cpSync(join(fixtures, 'npm', entry), source, { recursive: true });
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', join(work, 'packs'), source], {
      encoding: 'utf8',
      env: { ...process.env, HOME: join(work, 'home'), npm_config_cache: join(work, 'npm-cache'), npm_config_update_notifier: 'false' }
    }));
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    const tarball = readFileSync(join(work, 'packs', packed.filename));
    const file = `${manifest.name}-${manifest.version}.tgz`;
    const record = npmPackages.get(manifest.name) ?? { versions: {}, tarballs: {} };
    record.tarballs[file] = tarball;
    record.versions[manifest.version] = {
      ...manifest,
      _id: `${manifest.name}@${manifest.version}`,
      dist: {
        tarball: `${origin}/${manifest.name}/-/${file}`,
        integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
        shasum: createHash('sha1').update(tarball).digest('hex'),
        unpackedSize: packed.unpackedSize
      }
    };
    npmPackages.set(manifest.name, record);
  }
}

function packument(name) {
  const record = npmPackages.get(name);
  if (!record) return undefined;
  const versions = Object.keys(record.versions).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  return { name, 'dist-tags': { latest: versions.at(-1) }, versions: record.versions };
}

/* A minimal zip writer: STORED entries only, which every wheel installer accepts. */
function zipStored(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dosDate = (1 << 5) | 1; // 1980-01-01, the earliest valid DOS date.
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDirectory, end]);
}

function buildWheel() {
  const distInfo = 'chm_hello-1.0.0.dist-info';
  const files = [
    { name: 'chm_hello/__init__.py', data: readFileSync(join(fixtures, 'python', 'chm_hello', '__init__.py')) },
    { name: `${distInfo}/METADATA`, data: Buffer.from('Metadata-Version: 2.1\nName: chm-hello\nVersion: 1.0.0\nSummary: Package builder test fixture\n') },
    { name: `${distInfo}/WHEEL`, data: Buffer.from('Wheel-Version: 1.0\nGenerator: chm-fake-registry\nRoot-Is-Purelib: true\nTag: py3-none-any\n') },
    { name: `${distInfo}/entry_points.txt`, data: Buffer.from('[console_scripts]\nchm-hello-py = chm_hello:main\n') }
  ];
  const record = files
    .map(({ name, data }) => `${name},sha256=${createHash('sha256').update(data).digest('base64url')},${data.length}`)
    .concat([`${distInfo}/RECORD,,`, ''])
    .join('\n');
  const wheel = zipStored([...files, { name: `${distInfo}/RECORD`, data: Buffer.from(record) }]);
  return { file: 'chm_hello-1.0.0-py3-none-any.whl', data: wheel, sha256: createHash('sha256').update(wheel).digest('hex') };
}

packNpmFixtures();
const wheel = buildWheel();

const SAFE_SEGMENT = /^[A-Za-z0-9._+-]+$/;

function send(response, status, body, contentType) {
  response.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const path = new URL(request.url ?? '/', origin).pathname;
  const segments = path.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  if (path === '/-/ping') return send(response, 200, '{}', 'application/json');
  if (segments[0] === 'simple') {
    if (segments.length === 1) return send(response, 200, '<!DOCTYPE html><html><body><a href="/simple/chm-hello/">chm-hello</a></body></html>', 'text/html');
    if (segments.length === 2 && segments[1] === 'chm-hello') {
      return send(response, 200, `<!DOCTYPE html><html><body><a href="/packages/${wheel.file}#sha256=${wheel.sha256}">${wheel.file}</a></body></html>`, 'text/html');
    }
    return send(response, 404, 'not found', 'text/plain');
  }
  if (segments[0] === 'packages' && segments[1] === wheel.file && segments.length === 2) {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': wheel.data.length });
    return response.end(wheel.data);
  }
  if (segments[0] === 'python' && segments.length === 3 && segments.slice(1).every((segment) => SAFE_SEGMENT.test(segment))) {
    const file = join(pythonArchives, segments[1], segments[2]);
    if (!existsSync(file)) return send(response, 404, 'not found', 'text/plain');
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': statSync(file).size });
    return void createReadStream(file).pipe(response);
  }
  if (segments.length === 1) {
    const body = packument(segments[0]);
    return body ? send(response, 200, JSON.stringify(body), 'application/json') : send(response, 404, '{"error":"not found"}', 'application/json');
  }
  if (segments.length === 3 && segments[1] === '-') {
    const tarball = npmPackages.get(segments[0])?.tarballs[segments[2]];
    if (tarball) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': tarball.length });
      return response.end(tarball);
    }
  }
  return send(response, 404, 'not found', 'text/plain');
});

server.listen(port, '0.0.0.0', () => process.stdout.write(`fake registry listening on ${port}\n`));
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
