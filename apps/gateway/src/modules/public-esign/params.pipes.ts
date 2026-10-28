import { Injectable, PipeTransform } from '@nestjs/common';
import { PublicEsignError } from './errors';

// Параметрийг dms руу дамжуулахаас ӨМНӨ шалгана: буруу бол dms-тэй огт холбогдохгүй 404 буцаана (token таамаглах, path injection-ээс сэргийлнэ).

/** 32 random byte → base64url (43 тэмдэгт) */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** Crockford base32, I L O U-гүй, 12 тэмдэгт */
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
/** QR/цаасан дээр харуулдаг бүлэглэсэн хэлбэр XXXX-XXXX-XXXX */
const GROUPED_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/;
const PROVIDER_RE = /^(tridum|monpass)$/;

function notFound(): never {
  throw new PublicEsignError('NOT_FOUND');
}

@Injectable()
export class SigningTokenPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    return typeof value === 'string' && TOKEN_RE.test(value) ? value : notFound();
  }
}

/** Бүлэглэсэн хэлбэрийг зураасгүй (dms-д хадгалагддаг) хэлбэрт хөрвүүлж дамжуулна. */
@Injectable()
export class VerificationCodePipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== 'string') return notFound();
    const code = GROUPED_CODE_RE.test(value) ? value.replaceAll('-', '') : value;
    return CODE_RE.test(code) ? code : notFound();
  }
}

@Injectable()
export class ProviderPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    return typeof value === 'string' && PROVIDER_RE.test(value) ? value : notFound();
  }
}
