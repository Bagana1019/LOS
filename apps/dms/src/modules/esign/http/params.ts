// FR-11.4 Path параметрийн хэлбэрийг service-д хүрэхээс ӨМНӨ шалгана. Буруу хэлбэр = "олдсонгүй" (404): хүчинтэй токен/код байсан эсэх,
// шалгалтын шалтгаан гарахгүй (SigningNotFoundError нь үл мэдэгдэх ба солигдсон токентой яг ижил хариу өгдөг).
import { Injectable, type PipeTransform } from '@nestjs/common';
import { ESignProvider } from '@los/contracts';
import { isUuid } from '../stores/db-errors';
import { isLinkTokenShape } from '../domain/tokens';
import { parseVerificationCode } from '../domain/verification-code';
import { SigningNotFoundError } from '../errors';

/** Provider webhook замын сегмент: бүртгэлтэй provider-ийн нэр, ЖИЖИГ үсгээр (`tridum`, `monpass`) */
const PROVIDER_SEGMENTS: ReadonlySet<string> = new Set(ESignProvider.map((code) => code.toLowerCase()));

/** Ажилтны `:id` — uuid багана руу өөр хэлбэр өгвөл Prisma алдаа (500) шиднэ, тиймээс 404 */
@Injectable()
export class SigningRequestIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isUuid(value)) throw new SigningNotFoundError();
    return value;
  }
}

/** Зээлдэгчийн линкийн токен: 43 тэмдэгт base64url */
@Injectable()
export class LinkTokenPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isLinkTokenShape(value)) throw new SigningNotFoundError();
    return value;
  }
}

/** QR-ийн баталгаажуулах код: зураастай/зураасгүй, жижиг үсэг зөвшөөрч, хадгалсан хэлбэрт (12 тэмдэгт, том үсэг) буцаана */
@Injectable()
export class VerificationCodePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const code = parseVerificationCode(value);
    if (code === null) throw new SigningNotFoundError();
    return code;
  }
}

/** `tridum` | `monpass` (жижиг үсэг, яг таарах) */
@Injectable()
export class WebhookProviderPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!PROVIDER_SEGMENTS.has(value)) throw new SigningNotFoundError();
    return value;
  }
}
