import type { LoggerService } from '@nestjs/common';

type Level = 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';

/** Лог бүр нэг мөр JSON (CLAUDE.md §3.2-10). Хүсэлтийн body, токен, регистр, дугаарыг энд бичихгүй. */
export class JsonLogger implements LoggerService {
  private write(level: Level, message: unknown, context?: string, extra?: Record<string, unknown>): void {
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      service: 'portal-bff',
      context,
      msg: typeof message === 'string' ? message : message instanceof Error ? message.message : String(message),
      ...extra,
    });
    (level === 'error' || level === 'fatal' ? process.stderr : process.stdout).write(`${line}\n`);
  }
  log(message: unknown, context?: string) {
    this.write('log', message, context);
  }
  error(message: unknown, stack?: string, context?: string) {
    this.write('error', message, context, stack ? { stack } : undefined);
  }
  warn(message: unknown, context?: string) {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string) {
    this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string) {
    this.write('verbose', message, context);
  }
  fatal(message: unknown, context?: string) {
    this.write('fatal', message, context);
  }
}
