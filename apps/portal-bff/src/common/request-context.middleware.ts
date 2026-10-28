import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

const SAFE_CORRELATION_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Хүсэлт бүрт correlationId (CLAUDE.md §3.2-10) оноож, санхүүгийн өгөгдөл тул
 * бүх хариуг кэшлэхгүй (no-store) болгоно. Алдааны хариунд ч хамаарна.
 * Body parser-ээс ӨМНӨ ажиллах ёстой (`configureApp`): буруу JSON/хэт том body-ийн алдаа ч correlationId-тай буцна.
 * Давхар дуудагдсан ч аюулгүй (idempotent).
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  if (!req.correlationId) {
    const incoming = req.header('x-correlation-id');
    req.correlationId = incoming && SAFE_CORRELATION_ID.test(incoming) ? incoming : randomUUID();
  }
  res.setHeader('X-Correlation-Id', req.correlationId);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    requestContext(req, res, next);
  }
}
