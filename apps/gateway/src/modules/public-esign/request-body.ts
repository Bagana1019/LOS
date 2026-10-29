import type { Request, Response } from 'express';
import { PublicEsignError } from './errors';

// Хүсэлтийн биеийг БАЙТААР нь (parse/stringify хийлгүй) уншиж хэмжээг хязгаарлана — webhook-ийн HMAC байт тутамд хамаардаг.
// Gateway нь `bodyParser: false` (main.ts) тул бие stream хэвээр: энд зөвхөн хязгаартай уншина. Шахсан (content-encoding) бие дамжуулахгүй.

function tooLarge(res: Response): PublicEsignError {
  // Үлдсэн биеийг уншихгүй тул хариу өгсний дараа холболтыг хаана
  res.setHeader('Connection', 'close');
  return new PublicEsignError('PAYLOAD_TOO_LARGE');
}

function collect(req: Request, res: Response, maxBytes: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onFail);
      req.off('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        cleanup();
        req.pause();
        reject(tooLarge(res));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(size > 0 ? Buffer.concat(chunks) : undefined);
    };
    const onFail = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => onFail(new Error('request aborted by client'));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onFail);
    req.once('close', onClose);
  });
}

/** Хүсэлтийн биеийн байт; бие байхгүй бол undefined. Хэмжээ хэтэрвэл 413, шахсан (content-encoding) бол 415. */
export async function readRequestBody(req: Request, res: Response, maxBytes: number): Promise<Buffer | undefined> {
  const encoding = req.headers['content-encoding'];
  if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') throw new PublicEsignError('UNSUPPORTED_MEDIA_TYPE');
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > maxBytes) throw tooLarge(res);
  if (req.readableEnded) return undefined;
  return collect(req, res, maxBytes);
}
