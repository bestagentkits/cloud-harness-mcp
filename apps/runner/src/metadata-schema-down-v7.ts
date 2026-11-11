import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { downgradeMetadataSchemaToV7 } from './metadata-schema.js';

type DowngradeIo = {
  out: (line: string) => void;
  error: (line: string) => void;
};

const defaultIo: DowngradeIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`)
};

/**
 * Bounded v8 -> v7 rollback. Unlike `metadata:down:v1`, this never chains further down: it drops
 * only `github_user_authorizations`, so the downstream OAuth tables, the MCP gateway registry,
 * `api_keys`, and the secret tables survive. It discards every stored GitHub user authorization,
 * the encrypted token pairs and the non-secret `connected`/`revoked`/`disconnected` status alike.
 * It requires the ledger to be exactly version 8 and returns a non-zero exit code otherwise.
 */
export function downgradeStateDbToV7(path: string, io: DowngradeIo = defaultIo): number {
  const database = new DatabaseSync(resolve(path));
  try {
    database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const row = database.prepare('SELECT version FROM metadata_schema_meta WHERE singleton = 1').get() as { version: number } | undefined;
    if (!row || row.version !== 8) {
      io.error(`metadata-schema-down-v7: metadata schema must be version 8, found ${row?.version ?? 'none'}; no changes applied`);
      return 1;
    }
    downgradeMetadataSchemaToV7(database);
    io.out('metadata-schema-version=7');
    return 0;
  } finally {
    database.close();
  }
}

// Run the CLI only when this module is the process entry point, so the bounded
// downgrade is exercisable from tests without a compiled build. The shipped
// command is `node dist/metadata-schema-down-v7.js <state-db-path>`.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write('usage: metadata-schema-down-v7 <state-db-path>\n');
    process.exitCode = 1;
  } else {
    process.exitCode = downgradeStateDbToV7(path);
  }
}
