import { deflateRawSync } from 'node:zlib';

export type ZipFixtureEntry = {
  name: string;
  data: string | Buffer;
  /** 0 stores the entry, 8 (the default) deflates it, anything else is written as declared. */
  method?: number;
  /** A Unix file mode; when present the entry is marked as made on a Unix host and carries it. */
  mode?: number;
};

/**
 * Builds a zip in the test rather than committing binaries, so each fixture states exactly the shape
 * it is testing and the traversal cases stay readable.
 */
export function makeZip(entries: ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    // The reader does not verify the checksum, so a placeholder keeps the fixture focused.
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    // Version made by: the high byte is the host, and 3 (Unix) is what makes the mode meaningful.
    central.writeUInt16LE(entry.mode === undefined ? 20 : (3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.mode === undefined ? 0 : (entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + body.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralDirectory, eocd]);
}
