export interface SmsMessage {
  /** E.164: +976XXXXXXXX */
  to: string;
  text: string;
  /** Манай тал дахь лавлагаа (delivery.id) — провайдерын тайланд тааруулахад. */
  reference: string;
}
export interface SmsResult { providerMessageId: string }

/** Монголын SMS провайдер (Mobicom / Unitel / Skytel / G-Mobile …)-ийн нэгдсэн порт. Алдаа: ChannelError. */
export interface SmsGateway {
  send(message: SmsMessage): Promise<SmsResult>;
}
