import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock';

export type AuditAction =
  | 'AUTH_OTP_REQUESTED'
  | 'AUTH_OTP_SEND_FAILED'
  | 'AUTH_LOGIN'
  | 'AUTH_LOGIN_FAILED'
  | 'AUTH_REFRESH'
  | 'AUTH_REFRESH_REUSE_DETECTED'
  | 'AUTH_LOGOUT'
  | 'CONTRACT_DOWNLOADED'
  | 'CONTRACT_DOWNLOAD_ABORTED'
  | 'PAYMENT_CREATED'
  | 'PAYMENT_REPLAYED'
  | 'PAYMENT_REJECTED';

export interface AuditEvent {
  action: AuditAction;
  correlationId: string;
  outcome: 'SUCCESS' | 'FAILURE';
  customerId?: string;
  ip?: string;
  target?: { type: 'LOAN' | 'PAYMENT' | 'SESSION'; id: string };
  /** Зөвхөн PII-гүй, энгийн утга (код, дүн, төрөл). Регистр/утас/токен БИЧИХГҮЙ. */
  meta?: Record<string, string | number | boolean | null>;
}

export const AUDIT_SINK = Symbol('AUDIT_SINK');

export interface AuditSink {
  write(record: AuditEvent & { at: string }): void | Promise<void>;
}

/** Анхдагч sink: нэг мөр JSON (`audit:true`). Лог цуглуулагч (Loki/ELK) аудитын мөрийг ялгаж авна. */
export class LogAuditSink implements AuditSink {
  private readonly logger = new Logger('Audit');
  write(record: AuditEvent & { at: string }): void {
    this.logger.log({ ...record, audit: true, msg: record.action });
  }
}

/**
 * FR-13.5 / NFR-4: хэн, хэзээ, юуг. Харилцагчийн үйлдлийн мөр (нэвтрэлт, гэрээ татах, төлбөр).
 * TODO(follow-up): sink-ийг origination `audit_log` руу (дотоод API) эсвэл portal schema-д бичдэг болгох.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('AuditService');

  constructor(
    @Inject(AUDIT_SINK) private readonly sink: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Аудитын алдаа бизнес урсгалыг унагаахгүй (харин лог дээр алдаа гарна). */
  async record(event: AuditEvent): Promise<void> {
    try {
      await this.sink.write({ ...event, at: this.clock.now().toISOString() });
    } catch (err) {
      this.logger.error({ msg: 'audit sink failed', action: event.action, correlationId: event.correlationId, reason: (err as Error).message });
    }
  }
}
