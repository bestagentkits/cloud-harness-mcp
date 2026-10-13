import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Live TypeSafe verification.
 *
 * The key is loaded from a file outside the repository (preferred) or from the environment, and this
 * script prints a fingerprint of it rather than the key itself. The prompt is fixed and belongs to the
 * script, and the model's answer text is never printed: only the shape of the response, which is what
 * the engine's parsing depends on and what an unverified external assumption needs to be checked
 * against.
 */
const endpoint = process.env.TYPESAFE_ENDPOINT ?? 'https://api.typesafe.ai/v1/systemone';
const model = process.env.TYPESAFE_MODEL ?? 'jev-latest';
const keyFile = process.env.TYPESAFE_API_KEY_FILE;

function loadKey() {
  if (keyFile) {
    let content;
    try {
      content = readFileSync(keyFile, 'utf8');
    } catch (error) {
      throw new Error(`the key file could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    // A dotenv-style file is a common carrier for this, so the assignment form is understood rather
    // than treated as part of the key.
    const assigned = /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.+)$/m.exec(content);
    const value = (assigned ? assigned[1] : content).trim().replace(/^["']|["']$/g, '');
    if (value !== '') return value;
  }
  return (process.env.TYPESAFE_API_KEY ?? '').trim();
}

const key = loadKey();
if (key === '') throw new Error('set TYPESAFE_API_KEY_FILE to a file outside the repository, or TYPESAFE_API_KEY, and run this again');
if (!endpoint.startsWith('https://')) throw new Error('the endpoint must use https');

process.stdout.write(`endpoint ${endpoint}\nmodel ${model}\n`);
process.stdout.write(`key fingerprint ${createHash('sha256').update(key).digest('hex').slice(0, 12)}\n`);

const started = Date.now();
let response;
try {
  response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      state: 'Pick the option that fits a short request.',
      questions: {
        pick: {
          type: 'choice',
          question: 'Which option fits?',
          criteria: { alpha: 'the first option', beta: 'the second option' }
        },
        clear: { type: 'noul', question: 'Is the request clear?', criteria: { true: 'clear', false: 'unclear' } }
      }
    }),
    signal: globalThis.AbortSignal.timeout(15_000)
  });
} catch (error) {
  const name = error instanceof Error ? error.name : 'unknown';
  process.stdout.write(`request failed with ${name}; no response was received\n`);
  process.exit(1);
}

const body = await response.text();
process.stdout.write(`status ${response.status} in ${Date.now() - started}ms\n`);

if (!response.ok) {
  // The body is the provider's own message: it carries none of our prompt, and a schema error is
  // exactly what this script exists to surface. It is printed unless it appears to carry the key.
  const safe = !body.includes(key) && body.length <= 2_000;
  process.stdout.write(safe ? `response body: ${body}\n` : `response body length ${body.length}; not printed because it may carry the key\n`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(body);
} catch {
  process.stdout.write('the response was not JSON\n');
  process.exit(1);
}

const answers = parsed && typeof parsed === 'object' && parsed.answers && typeof parsed.answers === 'object'
  ? parsed.answers
  : undefined;
const picked = answers && answers.pick && typeof answers.pick === 'object' ? answers.pick.choice : undefined;
const noul = answers && answers.clear && typeof answers.clear === 'object' ? answers.clear.noul : undefined;
const usage = parsed && typeof parsed === 'object' ? parsed.usage : undefined;

process.stdout.write(`answers ${answers ? Object.keys(answers).join(', ') : 'absent'}\n`);
process.stdout.write(`choice is ${typeof picked}\nnoul is ${typeof noul}\n`);
if (usage && typeof usage === 'object') {
  process.stdout.write(`usage input_tokens=${usage.input_tokens} output_tokens=${usage.output_tokens}\n`);
}

if (typeof picked !== 'string' || typeof noul !== 'number') {
  process.stdout.write('the engine expects a string choice and a numeric noul; this response would be reported as unexpected_response\n');
  process.exit(1);
}

process.stdout.write('typesafe verification passed\n');
