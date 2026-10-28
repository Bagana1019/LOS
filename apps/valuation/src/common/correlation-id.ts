import { randomUUID } from 'node:crypto';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

// CLAUDE.md §3.2 rule 10: every request carries a correlationId; it is echoed on the response and passed to the adapters.
const HEADER = 'x-correlation-id';
// The value is echoed and logged, so only a conventional id shape is accepted (no spaces, no line breaks).
const PATTERN = /^[\w.:-]{1,128}$/;

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
}
interface ResponseLike {
  setHeader(name: string, value: string): unknown;
}

/** Runs before the pipes, so even a 400 carries the header. */
export function correlationIdMiddleware(req: RequestLike, res: ResponseLike, next: () => void): void {
  const incoming = req.headers[HEADER];
  const correlationId = typeof incoming === 'string' && PATTERN.test(incoming) ? incoming : randomUUID();
  req.headers[HEADER] = correlationId;
  res.setHeader('X-Correlation-Id', correlationId);
  next();
}

/** The id set by `correlationIdMiddleware`. */
export const CorrelationId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest<RequestLike>().headers[HEADER] as string;
});
