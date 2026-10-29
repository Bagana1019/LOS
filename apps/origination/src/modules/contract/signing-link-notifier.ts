import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { maskPhone } from './pii';
// Зээлдэгчид гарын үсгийн линк илгээх port. Бодит SMS adapter нь notification модулийн (Module 11) эзэмшил —
// тэр модуль энэ port-ыг хэрэгжүүлж, `SIGNING_SMS_TEMPLATE`/`renderSigningSms`-ыг ашиглана.

export interface SendSigningLinkInput {
  applicationId: string;
  /** PII — зөвхөн SMS adapter-т */
  phone: string;
  /** Нэг удаагийн токен агуулна — ХЭЗЭЭ Ч логлохгүй, ажилтны client-д буцаахгүй */
  signingUrl: string;
  expiresAt: Date;
}
export interface SigningLinkNotifier { sendLink(input: SendSigningLinkInput): Promise<void> }
export const SIGNING_LINK_NOTIFIER = Symbol('SIGNING_LINK_NOTIFIER');

export const SIGNING_SMS_TEMPLATE = 'Таны зээлийн гэрээг тоон гарын үсгээр баталгаажуулна уу: <url> (хүчинтэй: <date>)';

/** Монголын цагаар (UTC+8, DST-гүй) `YYYY-MM-DD` */
function ulaanbaatarDate(at: Date): string {
  return new Date(at.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

export function renderSigningSms(input: Pick<SendSigningLinkInput, 'signingUrl' | 'expiresAt'>): string {
  // нэг дамжуулалт — URL дотор `<date>` байсан ч дахин орлуулахгүй
  return SIGNING_SMS_TEMPLATE.replace(/<(url|date)>/g, (_m, key: string) => (key === 'url' ? input.signingUrl : ulaanbaatarDate(input.expiresAt)));
}

/** dev/тест: SMS илгээхгүй, зөвхөн {applicationId, phoneMasked} лог бичнэ. */
export class MockSigningLinkNotifier implements SigningLinkNotifier {
  private readonly logger = new Logger(MockSigningLinkNotifier.name);

  async sendLink(input: SendSigningLinkInput): Promise<void> {
    this.logger.log('mock SMS: signing link dispatched', { applicationId: input.applicationId, phoneMasked: maskPhone(input.phone) });
  }
}

/** Бодит SMS adapter холбогдох хүртэл production/real горимд линк "илгээгдсэн мэт" чимээгүй алдагдахаас хамгаална. */
export class UnconfiguredSigningLinkNotifier implements SigningLinkNotifier {
  async sendLink(_input: SendSigningLinkInput): Promise<void> {
    throw new ServiceUnavailableException('TODO(M11): SMS adapter not wired — bind to the notification module');
  }
}

export function createSigningLinkNotifier(env: NodeJS.ProcessEnv = process.env): SigningLinkNotifier {
  const mock = env.NODE_ENV !== 'production' && (env.INTEGRATION_MODE ?? 'mock') === 'mock';
  return mock ? new MockSigningLinkNotifier() : new UnconfiguredSigningLinkNotifier();
}
