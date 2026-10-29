// X-Correlation-Id нь зөвхөн лог-д (CLAUDE.md §3.2(9,10)): итгэхгүй оролт тул урт/тэмдэгтийг хязгаарлана (log injection-ээс сэргийлнэ).
const CORRELATION_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export function sanitizeCorrelationId(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && CORRELATION_ID_RE.test(v) ? v : undefined;
}
