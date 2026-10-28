import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

const SAFE_CORRELATION_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Хүсэлт бүрт correlationId (CLAUDE.md §3.2-10) оноож, санхүүгийн өгөгдөл тул
 * бүх хариуг кэшлэхгүй (no-store) болгоно. Алдааны хариунд ч хамаарна.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header('x-correlation-id');
    req.correlationId = incoming && SAFE_CORRELATION_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Correlation-Id', req.correlationId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  }
}
