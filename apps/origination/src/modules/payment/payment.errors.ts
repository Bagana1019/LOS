import { BadGatewayException, HttpException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { IntegrationNotConfiguredError } from '../../shared/integration-mode';
import { ProviderNotImplementedError, ProviderRejectedError, ProviderUnavailableError } from '../../integrations/payment-provider/provider-errors';

const logger = new Logger('PaymentProvider');

/** Брифийн §7: провайдерын алдааг монгол мессежтэй HTTP алдаа болгоно — дотоод дэлгэрэнгүй (токен, хариуны бие) гаргахгүй. */
export function toHttpError(e: unknown): unknown {
  if (e instanceof HttpException) return e;
  if (e instanceof IntegrationNotConfiguredError) {
    logger.warn(`${e.integration}: тохиргоо дутуу (${e.missing.join(', ')})`);
    return new ServiceUnavailableException({ code: 'PROVIDER_NOT_CONFIGURED', message: 'Төлбөрийн үйлчилгээний тохиргоо дутуу байна. Админтай холбогдоно уу.' });
  }
  if (e instanceof ProviderNotImplementedError) {
    return new HttpException({ code: 'PROVIDER_NOT_IMPLEMENTED', message: e.message }, 501);
  }
  if (e instanceof ProviderUnavailableError) {
    logger.warn(`${e.integration}: ${e.message}`);
    return new BadGatewayException({ code: 'PROVIDER_UNAVAILABLE', message: 'Төлбөрийн үйлчилгээ түр хүрэлцэхгүй байна. Түр хүлээгээд дахин оролдоно уу.' });
  }
  if (e instanceof ProviderRejectedError) {
    logger.warn(`${e.integration}: татгалзсан (${e.providerCode ?? 'код үгүй'})`);
    return new BadGatewayException({ code: 'PROVIDER_REJECTED', message: 'Төлбөрийн үйлчилгээ хүсэлтийг хүлээж авсангүй. Админтай холбогдоно уу.' });
  }
  return e;
}

export async function withProvider<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { throw toHttpError(e); }
}

/** Лог-д бичих аюулгүй богино тайлбар (PII-гүй). */
export function safeLogText(value: string, max = 48): string {
  return value.replace(/[^\w\-.:]/g, '?').slice(0, max);
}
