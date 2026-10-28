export interface PushMessage {
  token: string;
  title: string;
  body: string;
  /** FCM data payload: утга нь зөвхөн string. */
  data?: Record<string, string>;
  reference: string;
}
export interface PushResult { providerMessageId: string }

/** FCM (Android/Web) ба APNs (iOS)-ийн нэгдсэн порт. Алдаа: ChannelError (хүчингүй токен → INVALID_TOKEN). */
export interface PushGateway {
  send(message: PushMessage): Promise<PushResult>;
}
