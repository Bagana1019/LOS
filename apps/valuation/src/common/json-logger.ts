import type { LoggerService } from '@nestjs/common';

type Level = 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';

/**
 * One JSON object per line on stdout (stderr for error/fatal): CLAUDE.md §3.2 rule 10 asks for JSON logs with a correlationId.
 * A message that is already a JSON object (the events of AutoValuationService) is merged into the line instead of being double-encoded.
 */
export class JsonLogger implements LoggerService {
  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('log', message, optionalParams);
  }
  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }
  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }
  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }
  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('verbose', message, optionalParams);
  }
  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  private write(level: Level, message: unknown, optionalParams: unknown[]): void {
    // Nest calls (message, context) and, for errors, (message, stack, context).
    const context = optionalParams.length > 0 && typeof optionalParams.at(-1) === 'string' ? (optionalParams.at(-1) as string) : undefined;
    const stack = optionalParams.length > 1 && typeof optionalParams[0] === 'string' ? optionalParams[0] : undefined;
    const entry = { ...fieldsOf(message), level, time: new Date().toISOString(), context, stack };
    (level === 'error' || level === 'fatal' ? process.stderr : process.stdout).write(`${JSON.stringify(entry)}\n`);
  }
}

function fieldsOf(message: unknown): Record<string, unknown> {
  if (typeof message === 'string') {
    try {
      const parsed: unknown = JSON.parse(message);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // not JSON: a plain text message
    }
    return { message };
  }
  return { message: message instanceof Error ? message.message : String(message) };
}
