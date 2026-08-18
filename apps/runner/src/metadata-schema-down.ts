import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { downgradeMetadataSchemaToV1 } from './metadata-schema.js';

const path = process.argv[2];
if (!path) throw new Error('usage: metadata-schema-down <state-db-path>');
const database = new DatabaseSync(resolve(path));
try {
  database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  downgradeMetadataSchemaToV1(database);
  process.stdout.write('metadata-schema-version=1\n');
} finally {
  database.close();
}
