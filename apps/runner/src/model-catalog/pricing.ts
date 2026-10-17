// Converts a provider's decimal USD-per-token price into integer micro-USD per one
// million tokens without floating-point arithmetic. USD/token x 1e6 micros/USD x
// 1e6 tokens = USD/token x 1e12, so the decimal point moves twelve places. A
// fraction of a micro rounds up, so a stored price never understates cost.

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,4}))?$/u;
const MICROS_PER_MILLION_EXPONENT = 12;
// A wider exponent cannot describe a real token price and would only make BigInt work large.
const MAX_EXPONENT = 64;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Returns micro-USD per one million tokens, or `null` when the price is unknown:
 * missing, non-numeric, negative (OpenRouter uses `-1` for "varies"), or too large
 * to represent. `"0"` is an explicit free price and returns 0.
 */
export function usdPerTokenToMicrosPerMillion(value: unknown): number | null {
  let text: string;
  if (typeof value === 'string') text = value.trim();
  else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
  else return null;
  if (text.length === 0 || text.length > 64) return null;
  const match = DECIMAL.exec(text);
  if (!match) return null;
  const [, sign = '', integerDigits = '', fractionDigits = '', exponentText = '0'] = match;
  if (integerDigits.length === 0 && fractionDigits.length === 0) return null;
  const mantissa = BigInt(`${integerDigits}${fractionDigits}` || '0');
  if (mantissa === 0n) return 0;
  if (sign === '-') return null;
  const exponent = Number(exponentText) - fractionDigits.length + MICROS_PER_MILLION_EXPONENT;
  if (Math.abs(exponent) > MAX_EXPONENT) return exponent > 0 ? null : 1;
  let micros: bigint;
  if (exponent >= 0) {
    micros = mantissa * 10n ** BigInt(exponent);
  } else {
    const divisor = 10n ** BigInt(-exponent);
    micros = mantissa / divisor + (mantissa % divisor === 0n ? 0n : 1n);
  }
  return micros > MAX_SAFE ? null : Number(micros);
}
