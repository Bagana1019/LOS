/** Real интеграцийн API-ын баримт / credential байхгүй тул хэрэгжүүлээгүй (docs/04 "Хүний оролцоо" #1). */
export class CoreDepositNotImplementedError extends Error {
  readonly integration = 'core-deposit';
  constructor(message: string) {
    super(message);
    this.name = 'CoreDepositNotImplementedError';
  }
}
