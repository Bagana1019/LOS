import type { Response } from 'express';

/**
 * Public e-sign хариу бүрт (амжилт, алдаа) заавал тавих толгой: токен/PDF/гарын үсгийн мэдээлэл кэшлэгдэхгүй, MIME sniff хийгдэхгүй.
 * Upstream-ийн Cache-Control-ыг дамжуулдаггүй тул энэ нь үргэлж ялна.
 */
export function applyNoStoreHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
