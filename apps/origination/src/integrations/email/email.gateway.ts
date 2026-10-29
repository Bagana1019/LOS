export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Манай тал дахь лавлагаа (delivery.id) — Message-ID / толгойд. */
  reference: string;
}
export interface EmailResult { providerMessageId: string }

/** Имэйл илгээх нэгдсэн порт. Алдаа: ChannelError. */
export interface EmailGateway {
  send(message: EmailMessage): Promise<EmailResult>;
}
