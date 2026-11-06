import { describe, expect, it } from 'vitest';
import {
  buildEnvExample,
  envExampleFilename,
  FORBIDDEN_CLIENT_NAMES,
  FORBIDDEN_CLIENT_PREFIXES,
  parseDotEnv,
  planBulkImport,
  type SecretReference,
  secretNameError,
  secretValueError
} from './secret-model';
import {
  FORBIDDEN_SECRET_NAMES,
  FORBIDDEN_SECRET_PREFIXES,
  validateSecretName,
  validateSecretValue
} from '../../../../../packages/contracts/src/secret-policy';

// The browser mirror must accept and reject exactly what the contract does. Names are trimmed
// by the caller before either check (see secret-create-dialog.tsx), so the table feeds both
// sides the same trimmed input.
const NAME_TABLE: Array<[string, string]> = [
  ['API_KEY', 'valid upper case'],
  ['api_key', 'valid lower case'],
  ['_private', 'leading underscore'],
  ['A', 'single letter'],
  ['A'.repeat(100), 'exactly 100 characters'],
  ['A'.repeat(101), '101 characters'],
  ['', 'empty'],
  ['1ABC', 'leading digit'],
  ['MY-NAME', 'hyphen'],
  ['A B', 'space inside'],
  ['PATH', 'reserved exact'],
  ['path', 'reserved in lower case'],
  ['Home', 'reserved in mixed case'],
  ['PATHX', 'reserved name as a prefix only is allowed'],
  ['AUTHORIZATION', 'reserved control-plane name'],
  ['OWNER_ID', 'reserved control-plane name'],
  ['DOCKER_HOST', 'reserved exact'],
  ['BUILTIN_SKILLS_ROOT', 'reserved skills tier selector'],
  ['CH_FOO', 'reserved CH_ prefix'],
  ['CH', 'bare CH without underscore is not a prefix match'],
  ['CLOUDFLARE_TOKEN', 'reserved CLOUDFLARE_ prefix'],
  ['GITHUB_APP_ID', 'reserved GITHUB_APP_ prefix'],
  ['GIT_TRACE', 'reserved GIT_ prefix'],
  ['NPM_TOKEN', 'reserved NPM_ prefix'],
  ['NPMX', 'NPM without underscore is allowed'],
  ['UV_INDEX', 'reserved UV_ prefix'],
  ['UVX', 'UV without underscore is allowed'],
  ['LD_DEBUG', 'reserved LD_ prefix'],
  ['ACCESS_KEY', 'reserved ACCESS_ prefix'],
  ['ACCESSKEY', 'ACCESS without underscore is allowed'],
  ['GH_TOKEN', 'deliberately allowed GitHub credential'],
  ['GITHUB_TOKEN', 'deliberately allowed GitHub credential'],
  ['STRIPE_KEY', 'ordinary third-party name']
];

const VALUE_TABLE: Array<[string, string]> = [
  ['abcd', 'four ASCII bytes'],
  ['abc', 'three bytes is too short'],
  ['', 'empty'],
  ['éé', 'four bytes of UTF-8 accepted'],
  ['é', 'one character but two bytes is too short'],
  ['abc\0', 'NUL is refused'],
  ['abcd\n', 'line feed is refused'],
  ['abcd\r', 'carriage return is refused'],
  ['x'.repeat(65_536), 'exactly 64 KiB'],
  ['x'.repeat(65_537), 'one byte over 64 KiB'],
  ['€'.repeat(21_845), 'multi-byte value at 65,535 bytes'],
  ['€'.repeat(21_846), 'multi-byte value over the byte limit']
];

describe('secret-model name and value checks match the contract policy', () => {
  it.each(NAME_TABLE)('name %j (%s) is accepted or rejected the same way as the contract', (name) => {
    const client = secretNameError(name) === undefined;
    const contract = validateSecretName(name).ok;
    expect(client).toBe(contract);
  });

  it('trims a surrounding space before both checks, so the padded and bare names agree', () => {
    expect(validateSecretName('  SPACED  ')).toEqual({ ok: true, name: 'SPACED' });
    expect(secretNameError('  SPACED  '.trim())).toBeUndefined();
  });

  it.each(VALUE_TABLE)('value %j (%s) is accepted or rejected the same way as the contract', (value) => {
    const client = secretValueError(value) === undefined;
    const contract = validateSecretValue(value).ok;
    expect(client).toBe(contract);
  });

  it('keeps the reserved-name set and prefix list identical to the contract', () => {
    expect([...FORBIDDEN_CLIENT_NAMES].sort()).toEqual(Object.keys(FORBIDDEN_SECRET_NAMES).sort());
    expect([...FORBIDDEN_CLIENT_PREFIXES]).toEqual([...FORBIDDEN_SECRET_PREFIXES]);
  });

  it('gives fixed copy for each name rule', () => {
    expect(secretNameError('1ABC')).toMatch(/letter or underscore/);
    expect(secretNameError('PATH')).toBe('This name is reserved for the control plane or toolchain.');
    expect(secretNameError('CH_FOO')).toBe('Names starting with CH_ are reserved.');
    expect(secretNameError('GH_TOKEN')).toBeUndefined();
  });

  it('gives fixed copy for each value rule', () => {
    expect(secretValueError('abc')).toBe('Enter at least 4 characters.');
    expect(secretValueError('x'.repeat(65_537))).toBe('Keep the value to 64 KiB.');
    expect(secretValueError('abcd\n')).toBe('The value cannot contain line breaks or NUL characters.');
    expect(secretValueError('abcd')).toBeUndefined();
  });
});

describe('parseDotEnv', () => {
  it('reads names and values, strips matching quotes and an export prefix', () => {
    const items = parseDotEnv([
      'STRIPE_KEY="sk-test-not-real"',
      "export OTHER='value-one'",
      'PLAIN=abc=def',
      'SPACED =  padded  '
    ].join('\n'));
    expect(items).toEqual([
      { name: 'STRIPE_KEY', value: 'sk-test-not-real', description: null },
      { name: 'OTHER', value: 'value-one', description: null },
      { name: 'PLAIN', value: 'abc=def', description: null },
      { name: 'SPACED', value: 'padded', description: null }
    ]);
  });

  it('attaches the comment block above an assignment as its description', () => {
    const [item] = parseDotEnv('# Stripe key\n## for production\nSTRIPE_KEY=sk-test-not-real');
    expect(item?.description).toBe('Stripe key / for production');
  });

  it('does not carry a comment across a blank line', () => {
    const [item] = parseDotEnv('# orphan comment\n\nKEY=value1');
    expect(item?.description).toBeNull();
  });

  it('keeps an unmatched quote as part of the value', () => {
    const [item] = parseDotEnv('KEY="unterminated');
    expect(item?.value).toBe('"unterminated');
  });

  it('skips lines without an assignment or with an empty name', () => {
    expect(parseDotEnv('no equals here\n=orphan\n')).toEqual([]);
  });

  it('truncates a description to the 500 character limit', () => {
    const [item] = parseDotEnv(`# ${'d'.repeat(600)}\nKEY=value1`);
    expect(item?.description).toHaveLength(500);
  });
});

describe('planBulkImport', () => {
  const existing: SecretReference[] = [
    { id: 's1', name: 'EXISTING', description: null, generation: 3, version: 2 },
    { id: 's2', name: 'NO_VERSION', description: null, generation: 7, version: null }
  ];

  it('creates new names at generation 0 and rotates existing names from their current generation', () => {
    const text = 'NEW_ONE=value-one\nEXISTING=value-two\nNO_VERSION=value-three';
    const { lines, items, blocked } = planBulkImport(text, existing);
    expect(blocked).toBe(0);
    expect(lines.map((line) => line.kind)).toEqual(['create', 'rotate', 'rotate']);
    expect(lines[1]).toEqual({ kind: 'rotate', name: 'EXISTING', description: null, fromVersion: 2, toVersion: 3 });
    expect(lines[2]).toMatchObject({ kind: 'rotate', fromVersion: 7, toVersion: 8 });
    expect(items).toEqual([
      { name: 'NEW_ONE', value: 'value-one', action: 'create', expectedGeneration: 0 },
      { name: 'EXISTING', value: 'value-two', action: 'rotate', expectedGeneration: 3 },
      { name: 'NO_VERSION', value: 'value-three', action: 'rotate', expectedGeneration: 7 }
    ]);
  });

  it('blocks the whole batch on a rejected name and keeps the value out of the preview', () => {
    const { lines, items, blocked } = planBulkImport('PATH=/usr/bin\nOK_NAME=secret-value', []);
    expect(blocked).toBe(1);
    expect(lines[0]).toMatchObject({ kind: 'rejected', name: 'PATH' });
    expect(JSON.stringify(lines)).not.toContain('/usr/bin');
    expect(items.map((item) => item.name)).toEqual(['OK_NAME']);
  });

  it('marks a repeated name as a duplicate and blocks it', () => {
    const { lines, blocked } = planBulkImport('DUP_NAME=first-value\nDUP_NAME=second-value', []);
    expect(lines.map((line) => line.kind)).toEqual(['create', 'duplicate']);
    expect(blocked).toBe(1);
  });

  it('omits the description key from an item that has none', () => {
    const { items } = planBulkImport('# described\nWITH_DESC=value-one\nNO_DESC=value-two', []);
    expect(items[0]).toEqual({ name: 'WITH_DESC', value: 'value-one', description: 'described', action: 'create', expectedGeneration: 0 });
    expect(items[1]).not.toHaveProperty('description');
  });
});

describe('buildEnvExample and envExampleFilename', () => {
  it('writes each description line as a comment, then NAME= with no value', () => {
    const text = buildEnvExample([
      { id: 'a', name: 'ALPHA', description: 'first line\n\nsecond line', generation: 1 },
      { id: 'b', name: 'BETA', description: null, generation: 1 }
    ]);
    expect(text).toBe('# first line\n# second line\nALPHA=\nBETA=\n');
    expect(text).not.toMatch(/=\S/);
  });

  it('names the file after the scope, falling back to global', () => {
    expect(envExampleFilename('Prod_East')).toBe('prod_east.env.example');
    expect(envExampleFilename('')).toBe('global.env.example');
    expect(envExampleFilename(undefined)).toBe('global.env.example');
  });
});
