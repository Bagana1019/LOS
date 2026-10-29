// Verifier + QR баталгаажуулалтыг нэгтгэсэн Nest үйлчилгээ. Import pipeline энийг дуудна (parse → verify). BSA-FR-2.2, 2.3.
import { Inject, Injectable } from '@nestjs/common';
import { StatementParserRegistry } from '../parser.registry';
import type { ParsedStatement, StatementFileMeta, VerificationResult } from '../statement.types';
import { QR_VERIFIER, type QrVerifier } from './qr-verifier';
import type { VerifyOptionsInput } from './verify-defaults';
import { requiresQr, verifyStatement } from './verify-statement';

@Injectable()
export class StatementVerificationService {
  constructor(
    @Inject(StatementParserRegistry) private readonly registry: StatementParserRegistry,
    @Inject(QR_VERIFIER) private readonly qr: QrVerifier,
  ) {}

  /**
   * Банкны бодлогыг (зураг хүлээн авах, IBAN хэлбэр) registry-ээс авч, QR шаардлагатай файлд QrVerifier-ийг дуудаж verifyStatement-ийг
   * ажиллуулна. QrVerifier алдаа шидвэл QR "шалгаагүй" (null) гэж үзнэ — verifier унахгүй.
   */
  async verify(parsed: ParsedStatement, meta: StatementFileMeta, options: VerifyOptionsInput = {}): Promise<VerificationResult> {
    const policy = options.policy ?? this.registry.policyFor(parsed.bank);
    let qr: boolean | null = null;
    if (requiresQr(meta)) {
      try {
        qr = await this.qr.verify(meta.qrPayloads ?? []);
      } catch {
        qr = null; // TODO(bank API): алдааг QR_NOT_VERIFIED-ийн дотор тусад нь ялгах (endpoint унасан vs QR буруу)
      }
    }
    return verifyStatement(parsed, { ...options, policy }, meta, qr);
  }
}
