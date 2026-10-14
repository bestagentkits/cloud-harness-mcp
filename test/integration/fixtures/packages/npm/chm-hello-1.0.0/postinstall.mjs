import { writeFileSync } from 'node:fs';
import { URL } from 'node:url';

// Proves whether lifecycle scripts ran: the builder disables them unless the plan allows them.
writeFileSync(new URL('./postinstall-ran', import.meta.url), 'ran\n');
