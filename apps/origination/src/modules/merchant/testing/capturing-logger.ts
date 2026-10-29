import type { LoggerService } from '@nestjs/common';

/** Тест: Nest-ийн лог мөрүүдийг барьж аваад PII scan хийхэд ашиглана (stdout руу бичихгүй). */
export class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];
  private push(level: string, message: unknown, rest: unknown[]) {
    this.lines.push(`${level} ${[message, ...rest].map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join(' ')}`);
  }
  log(message: unknown, ...rest: unknown[]) { this.push('log', message, rest); }
  error(message: unknown, ...rest: unknown[]) { this.push('error', message, rest); }
  warn(message: unknown, ...rest: unknown[]) { this.push('warn', message, rest); }
  debug(message: unknown, ...rest: unknown[]) { this.push('debug', message, rest); }
  verbose(message: unknown, ...rest: unknown[]) { this.push('verbose', message, rest); }
  get text() { return this.lines.join('\n'); }
}
