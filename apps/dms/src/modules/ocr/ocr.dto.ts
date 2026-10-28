// POST /api/ocr/extract-ийн multipart талбарууд (файлаас бусад). Хэлбэр нь текст тул 'true'/'1'/'false'/'0' хүлээн авна.
import { z } from 'zod';

export const OCR_DOC_TYPE_CHOICES = ['ID_CARD', 'SALARY_CERTIFICATE', 'GENERIC', 'AUTO'] as const;

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const textBoolean = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return v;
};

export const extractBodySchema = z
  .object({
    docType: z.preprocess(emptyToUndefined, z.enum(OCR_DOC_TYPE_CHOICES).default('AUTO')),
    includeText: z.preprocess(emptyToUndefined, z.preprocess(textBoolean, z.boolean()).default(false)),
  })
  .strict();

export type ExtractBody = z.infer<typeof extractBodySchema>;
