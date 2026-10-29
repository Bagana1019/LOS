// FR-11.4 PDF / .p7s татах хариу: Content-Disposition (RFC 6266 + 5987) нь кирилл нэрийг зөв дамжуулна, Content-Length тавина.
import { StreamableFile } from '@nestjs/common';
import type { SigningDocument } from '../signing.service';

export type Disposition = 'inline' | 'attachment';

/** RFC 5987 `attr-char`: encodeURIComponent-ээс гадна `'()*`-ийг мөн кодлоно */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `attachment; filename="ASCII-fallback"; filename*=UTF-8''<кодлогдсон нэр>`. Fallback-д ASCII үсэг/тоо/`.-_ `-ээс бусдыг `_` болгоно */
export function contentDisposition(disposition: Disposition, fileName: string): string {
  const fallback = fileName.replace(/[^A-Za-z0-9._ -]/g, '_');
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}

export function fileResponse(document: SigningDocument, disposition: Disposition): StreamableFile {
  return new StreamableFile(document.bytes, {
    type: document.mime,
    disposition: contentDisposition(disposition, document.fileName),
    length: document.bytes.length,
  });
}
