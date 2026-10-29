// Интеграцийн алдаа — NFR-2: ойлгомжтой мессеж, дотоод дэлгэрэнгүйг (токен, хариуны бие) гаргахгүй.

/** Timeout / 5xx / сүлжээний алдаа — түр зуурын, дахин оролдож болно. */
export class ProviderUnavailableError extends Error {
  constructor(readonly integration: string, message = `${integration}: үйлчилгээ түр хүрэлцэхгүй байна`, readonly cause?: unknown) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/** Провайдер хүсэлтийг 4xx-ээр татгалзсан (буруу тохиргоо, дүн, төлөв). Дахин оролдсоноор засагдахгүй. */
export class ProviderRejectedError extends Error {
  constructor(readonly integration: string, readonly providerCode: string | null, message = `${integration}: хүсэлтийг татгалзлаа`) {
    super(message);
    this.name = 'ProviderRejectedError';
  }
}

/** Real интеграцийн skeleton — баримт/credential байхгүй тул хэрэгжээгүй (docs/04 "Хүний оролцоо" #1). */
export class ProviderNotImplementedError extends Error {
  constructor(readonly integration: string, message = `${integration}: бодит холболт хараахан хэрэгжээгүй байна`) {
    super(message);
    this.name = 'ProviderNotImplementedError';
  }
}
