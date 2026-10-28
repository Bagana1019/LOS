import { type LoggerService } from '@nestjs/common';
import { getRequestContext } from '../context/request-context';

const LEVELS = ['debug', 'verbose', 'log', 'warn', 'error'] as const;
type Level = typeof LEVELS[number];
const SENSITIVE = /(pass(word)?|secret|token|authorization|cookie|register(_?no)?|account(_?no)?|iban|photo)/i;

/** Лог-д хувийн мэдээлэл/нууц орохгүй байх (CLAUDE.md §6.5): мэдрэмтгий түлхүүртэй талбарыг `[redacted]` болгоно. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1)]));
}

/** CLAUDE.md §3.2.10: JSON лог, correlationId-тай. */
export class JsonLogger implements LoggerService {
  private readonly min: number;
  constructor(private readonly service: string, level: string = process.env.LOG_LEVEL ?? 'log', private readonly out: (line: string) => void = (l) => process.stdout.write(`${l}\n`)) {
    this.min = Math.max(0, LEVELS.indexOf(level as Level));
  }
  log(msg: unknown, ...rest: unknown[]) { this.write('log', msg, rest); }
  error(msg: unknown, ...rest: unknown[]) { this.write('error', msg, rest); }
  warn(msg: unknown, ...rest: unknown[]) { this.write('warn', msg, rest); }
  debug(msg: unknown, ...rest: unknown[]) { this.write('debug', msg, rest); }
  verbose(msg: unknown, ...rest: unknown[]) { this.write('verbose', msg, rest); }

  private write(level: Level, msg: unknown, rest: unknown[]) {
    if (LEVELS.indexOf(level) < this.min) return;
    const ctx = getRequestContext();
    const context = typeof rest[rest.length - 1] === 'string' ? (rest.pop() as string) : undefined;
    const extra = rest.length ? { extra: redact(rest.length === 1 ? rest[0] : rest) } : {};
    const message = msg instanceof Error ? `${msg.name}: ${msg.message}` : typeof msg === 'string' ? msg : JSON.stringify(redact(msg));
    this.out(JSON.stringify({ ts: new Date().toISOString(), level, service: this.service, context, msg: message, correlationId: ctx?.correlationId ?? null, userId: ctx?.userId ?? null, ...extra }));
  }
}
