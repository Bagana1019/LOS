// Зэрэг ажиллах OCR-ийн тоог хязгаарлана (CPU-ийн DoS): maxConcurrent ажиллаж, maxQueue хүлээнэ, илүүд нь шууд татгалзана.
export class GateFullError extends Error {
  constructor() {
    super('OCR gate is full');
    this.name = 'GateFullError';
  }
}

export class ConcurrencyGate {
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueue: number,
  ) {}

  /** fn-ийг эгнээнд оруулж ажиллуулна. Дараалал дүүрэн бол GateFullError. fn амжилтгүй болсон ч слотыг чөлөөлнө. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      if (this.waiters.length >= this.maxQueue) throw new GateFullError();
      await new Promise<void>((resolve) => this.waiters.push(resolve)); // слотыг дамжуулж авна (running өөрчлөгдөхгүй)
    } else {
      this.running += 1;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.running -= 1;
    }
  }

  get stats(): { running: number; queued: number } {
    return { running: this.running, queued: this.waiters.length };
  }
}
