import type { LoggerService } from '@nestjs/common';

type Level = 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !(v instanceof Error) && !Array.isArray(v);

/**
 * Лог бүр нэг мөр JSON (CLAUDE.md §3.2-10). Объект өгвөл талбаруудыг мөрийн дээд түвшинд (`correlationId`, `audit`, …) гаргана,
 * ингэснээр лог цуглуулагч (Loki/ELK) түлхүүрээр шүүнэ. Хүсэлтийн body, токен, регистр, дугаарыг энд бичихгүй.
 */
export class JsonLogger implements LoggerService {
  private write(level: Level, message: unknown, rest: unknown[]): void {
    // Nest нь context-ийг сүүлийн параметр болгон залгадаг: error(msg, stack?, context?) / log(msg, context?)
    const params = rest.filter((p) => p !== undefined);
    const context = typeof params[params.length - 1] === 'string' ? (params[params.length - 1] as string) : undefined;
    const stack = level === 'error' && params.length >= 2 && typeof params[0] === 'string' ? (params[0] as string) : undefined;

    const fields = isRecord(message) ? message : {};
    const { msg: customMsg, ...extra } = fields;
    const msg = isRecord(message)
      ? String(customMsg ?? '')
      : typeof message === 'string'
        ? message
        : message instanceof Error
          ? message.message
          : String(message);
    const line = JSON.stringify({ ...extra, level, time: new Date().toISOString(), service: 'portal-bff', context, msg, ...(stack ? { stack } : {}) });
    (level === 'error' || level === 'fatal' ? process.stderr : process.stdout).write(`${line}\n`);
  }
  log(message: unknown, ...rest: unknown[]) {
    this.write('log', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.write('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.write('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.write('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.write('verbose', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.write('fatal', message, rest);
  }
}
