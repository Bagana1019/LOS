// Мэдэгдлийн суваг (SMS / Email / Push) gateway-үүдийн нийтлэг алдаа (FR-13.2).
// DeliveryProcessor нь `retryable`-ээр дахин оролдох эсэхийг, `code`-оор төлөвийг шийднэ.
export type ChannelErrorCode = 'INVALID_ADDRESS' | 'INVALID_TOKEN' | 'PROVIDER_ERROR' | 'RATE_LIMITED' | 'TIMEOUT';

const DEFAULT_MESSAGES: Record<ChannelErrorCode, string> = {
  INVALID_ADDRESS: 'Хүлээн авагчийн хаяг буруу байна',
  INVALID_TOKEN: 'Push токен хүчингүй болсон байна',
  PROVIDER_ERROR: 'Мэдэгдэл илгээх үйлчилгээний алдаа',
  RATE_LIMITED: 'Үйлчилгээ түр хязгаарласан байна',
  TIMEOUT: 'Мэдэгдэл илгээх үйлчилгээ хариу өгсөнгүй',
};

/** Мессежэд хүлээн авагчийн хаяг (утас, имэйл, токен) ОРУУЛАХГҮЙ — лог руу алдаг. */
export class ChannelError extends Error {
  constructor(readonly code: ChannelErrorCode, readonly retryable: boolean, message?: string) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'ChannelError';
  }
}

/** Real интеграцийн API-ын баримт / credential байхгүй тул хэрэгжүүлээгүй (docs/04 "Хүний оролцоо" #1). */
export class IntegrationNotImplementedError extends Error {
  constructor(readonly integration: string, message: string) {
    super(message);
    this.name = 'IntegrationNotImplementedError';
  }
}

/** Лог/UI-д харуулах нуугдмал хаяг. */
export function maskAddress(channel: 'SMS' | 'EMAIL' | 'PUSH' | string, address: string | null | undefined): string | null {
  if (!address) return null;
  if (channel === 'EMAIL') {
    const at = address.lastIndexOf('@');
    if (at < 1) return '***';
    return `${address[0]}***${address.slice(at)}`;
  }
  if (channel === 'PUSH') return address.length <= 8 ? '***' : `${address.slice(0, 4)}***${address.slice(-4)}`;
  // SMS (утас): улсын код + сүүлийн 2 цифр
  const digits = address.replace(/\s/g, '');
  if (digits.length <= 6) return '***';
  return `${digits.slice(0, digits.startsWith('+976') ? 4 : 2)}${'*'.repeat(Math.max(3, digits.length - (digits.startsWith('+976') ? 6 : 4)))}${digits.slice(-2)}`;
}
