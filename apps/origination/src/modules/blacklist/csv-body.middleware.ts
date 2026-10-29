import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WRITE_ROLES, authorize } from './blacklist.context';

/** FR-13.1: CSV импортын body-ийн дээд хэмжээ. */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;

type BodyRequest = IncomingMessage & { body?: unknown };

const tooLarge = () => new PayloadTooLargeException(`CSV body must not exceed ${MAX_CSV_BYTES / 1024 / 1024} MB`);
const abortedError = () => new BadRequestException('Request body was aborted');
const NOT_UTF8 = 'CSV body must be valid UTF-8 (save the file as "CSV UTF-8"; windows-1251 and UTF-16 are not supported)';

/**
 * Body-г MAX_CSV_BYTES хүртэл уншина. Хэтэрмэгц listener-ээ салгаж, stream-ийг зогсооно: cap + нэг chunk-аас илүү
 * буфферлэхгүй, drain хийхгүй (хариу явсны дараа холболтыг хаана — csvBodyMiddleware).
 */
function readBody(req: BodyRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const detach = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CSV_BYTES) {
        detach();
        req.pause();
        chunks.length = 0;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      detach();
      resolve(Buffer.concat(chunks, size));
    };
    // Клиент таслахад Node req-г 'aborted' (ECONNRESET) алдаатай destroy хийж, 'error' нь 'close'-оос ӨМНӨ ирдэг (listener байвал).
    // Үүнийг ердийн таслалт гэж үзнэ (чимээгүй 400): тохиолдлын 500 + ERROR лог (stack) болохгүй.
    const onError = (e: Error & { code?: unknown }) => {
      detach();
      reject(e.code === 'ECONNRESET' || e.message === 'aborted' || !req.complete ? abortedError() : e);
    };
    // Клиент body дуусахаас өмнө таславал 'end' ирэхгүй — амлалт өлгөөтэй үлдэхгүй.
    const onClose = () => {
      detach();
      if (req.complete) resolve(Buffer.concat(chunks, size));
      else reject(abortedError());
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('close', onClose);
  });
}

/**
 * UTF-8 (BOM-г хасаад) хатуу задлана: Windows-1251/UTF-16 файл U+FFFD болж чимээгүй хадгалагдахгүй (kyc-д хэзээ ч таарахгүй).
 * Хатуу декодер нь зөвхөн буруу БАЙТ-ыг барина; аль хэдийн U+FFFD болгон хөрвүүлсэн (алдагдсан) текст нь зөв UTF-8 тул түүнийг мөн няцаана.
 */
function decodeUtf8(body: Buffer): string {
  const bytes = body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf ? body.subarray(3) : body;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new BadRequestException(NOT_UTF8);
  }
  if (text.includes('\uFFFD')) throw new BadRequestException(NOT_UTF8);
  return text;
}

/**
 * `text/csv` body-г string болгож req.body-д тавина. Nest-ийн анхдагч parser зөвхөн json/urlencoded-ийг (100 KB) задалдаг тул
 * зөвхөн `POST /blacklist/import` дээр модулиас холбоно (BlacklistModule.configure).
 *
 * Middleware нь guard-аас ӨМНӨ ажилладаг тул body-г уншихаас өмнө энд нэвтрэлт/дүрийг шалгаж (401/400/403), Content-Length
 * хэтэрвэл (413) уншихгүйгээр татгалзана. Уншаагүй body-тэй татгалзахад `Connection: close` тавьж, үлдсэнийг drain хийлгэхгүй.
 */
export async function csvBodyMiddleware(req: BodyRequest, res: ServerResponse, next: (err?: unknown) => void): Promise<void> {
  if (!/^text\/csv\b/i.test(req.headers['content-type'] ?? '')) return next();
  let bodyRead = false;
  try {
    authorize(req.headers, WRITE_ROLES);
    if (Number(req.headers['content-length']) > MAX_CSV_BYTES) throw tooLarge();
    const raw = await readBody(req);
    bodyRead = true;
    req.body = decodeUtf8(raw);
  } catch (e) {
    if (!bodyRead && !res.headersSent) res.setHeader('Connection', 'close');
    return next(e);
  }
  next();
}
