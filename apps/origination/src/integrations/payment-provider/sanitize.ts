import { maskAccountNo } from '@los/database';

// NFR-5 / brief §8: providerResponseJson, rawJson-д токен, нууц үг бичихгүй; дансны дугаар, утас зэргийг нуугдмал болгоно.
const SECRET_KEY = /(token|secret|password|passwd|authorization|api[_-]?key|signature|credential)/i;
const PII_KEY = /(account|iban|card|phone|email|register|paid_by|payer)/i;

export function sanitizeRaw(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeRaw(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) continue;
      if (PII_KEY.test(k) && (typeof v === 'string' || typeof v === 'number')) { out[k] = maskAccountNo(String(v)); continue; }
      out[k] = sanitizeRaw(v, depth + 1);
    }
    return out;
  }
  return value;
}
