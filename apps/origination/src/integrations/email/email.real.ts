import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { requireEnv } from '../../shared/integration-mode';
import { ChannelError } from '../channel/channel-error';
import type { EmailGateway, EmailMessage, EmailResult } from './email.gateway';

export const EMAIL_REQUIRED_ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];

/** nodemailer Transporter-ийн бидэнд хэрэгтэй хэсэг — тестэд `jsonTransport` эсвэл stub inject хийнэ. */
export type MailTransport = Pick<Transporter, 'sendMail'>;

export interface RealEmailOptions {
  env?: NodeJS.ProcessEnv;
  /** Inject хийвэл env-ийн SMTP тохиргоог шалгахгүй (тест). SMTP_FROM-ыг env-ээс ('from' option-оор дарж болно). */
  transport?: MailTransport;
  from?: string;
  /** Ачаалал (CLAUDE.md §3.1: гадаад дуудлагын timeout 15с). */
  timeoutMs?: number;
}

interface SmtpLikeError { code?: string; responseCode?: number; command?: string }

/**
 * SMTP алдааг ангилна. Брифд "4xx → retryable=false, 5xx → retryable=true" гэж бичигдсэн боловч RFC 5321 ёсоор эсрэгээрээ:
 * 4yz = түр (дахин оролдоно), 5yz = байнгын (дахин оролдоход утгагүй: 550 хайрцаг байхгүй). RFC-ийн дагуу хэрэгжүүлсэн — DECISIONS-д тэмдэглэсэн.
 */
export function classifySmtpError(err: unknown): ChannelError {
  const e = (err ?? {}) as SmtpLikeError;
  const rc = typeof e.responseCode === 'number' ? e.responseCode : undefined;
  if (rc !== undefined) {
    if (rc === 421 || rc === 450 || rc === 451 || rc === 452) return new ChannelError(rc === 421 || rc === 452 ? 'RATE_LIMITED' : 'PROVIDER_ERROR', true);
    if (rc >= 400 && rc < 500) return new ChannelError('PROVIDER_ERROR', true);
    if ([501, 550, 551, 553].includes(rc)) return new ChannelError('INVALID_ADDRESS', false);
    if (rc >= 500 && rc < 600) return new ChannelError('PROVIDER_ERROR', false);
  }
  switch (e.code) {
    case 'ETIMEDOUT': case 'ESOCKETTIMEDOUT': case 'ECONNECTION_TIMEOUT': return new ChannelError('TIMEOUT', true);
    case 'EENVELOPE': return new ChannelError('INVALID_ADDRESS', false);
    case 'EAUTH': return new ChannelError('PROVIDER_ERROR', false, 'Имэйл серверт нэвтрэх эрх буруу байна'); // тохиргоо засахаас өмнө дахин оролдох нь дэмий
    default: return new ChannelError('PROVIDER_ERROR', true); // сүлжээ: ECONNECTION, ECONNREFUSED, ESOCKET, EDNS …
  }
}

/** SMTP (nodemailer). Тохиргоо: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, (нэмэлт) SMTP_SECURE=true|false (анхдагч: port 465 → true). */
export class RealEmailGateway implements EmailGateway {
  readonly mode = 'real' as const;
  private readonly env: NodeJS.ProcessEnv;
  private transport: MailTransport | null;
  private readonly from: string | null;
  private readonly timeoutMs: number;

  constructor(opts: RealEmailOptions = {}) {
    this.env = opts.env ?? process.env;
    this.transport = opts.transport ?? null;
    this.from = opts.from ?? null;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** Тохиргоо дутуу бол IntegrationNotConfiguredError (DeliveryProcessor → FAILED/NOT_CONFIGURED). */
  private resolve(): { transport: MailTransport; from: string } {
    if (this.transport && this.from) return { transport: this.transport, from: this.from };
    const e = requireEnv('email', EMAIL_REQUIRED_ENV, this.env);
    const port = Number(e.SMTP_PORT);
    const secure = this.env.SMTP_SECURE ? this.env.SMTP_SECURE.toLowerCase() === 'true' : port === 465;
    this.transport ??= nodemailer.createTransport({
      host: e.SMTP_HOST, port, secure, auth: { user: e.SMTP_USER, pass: e.SMTP_PASS },
      connectionTimeout: this.timeoutMs, greetingTimeout: this.timeoutMs, socketTimeout: this.timeoutMs,
    });
    return { transport: this.transport, from: this.from ?? e.SMTP_FROM };
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    const { transport, from } = this.resolve();
    try {
      const info = await transport.sendMail({
        from, to: message.to, subject: message.subject, text: message.text, html: message.html,
        headers: { 'X-LOS-Reference': message.reference },
      });
      return { providerMessageId: String(info.messageId ?? message.reference) };
    } catch (err) {
      throw classifySmtpError(err);
    }
  }
}
