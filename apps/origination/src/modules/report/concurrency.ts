// Тайлангийн хүнд ажлууд (Excel экспорт, dashboard) ижил Node процесс болон нийтлэг Prisma pool-ыг (4 цөм → 9 холболт) хуваалцдаг.
// Хэрэглэгч олон дарахад pool дүүрч (P2024 → 500) эсвэл event loop гацахаас хамгаалах процесс доторх хязгаарлагч.

/** Event loop-д амс өгнө: хүлээж буй I/O, timer, бусад хүсэлт (төлбөрийн callback…) ажиллах боломж олдоно. */
export const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Дараалал дүүрсэн үед `Semaphore.run` шиддэг алдаа (service нь 429 болгоно). */
export class SemaphoreFullError extends Error {
  constructor(readonly queued: number) {
    super(`Хүлээлгийн дараалал дүүрсэн (${queued})`);
    this.name = 'SemaphoreFullError';
  }
}

/** Нэгэн зэрэг `limit` ажил; илүү нь FIFO дарааллаар хүлээнэ (дараалал `maxQueue`-ээс их бол `SemaphoreFullError`). */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number, readonly maxQueue = Number.POSITIVE_INFINITY) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Semaphore limit ≥ 1 бүхэл тоо байх ёстой');
  }

  get running(): number { return this.active; }
  get queued(): number { return this.waiters.length; }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiters.length >= this.maxQueue) throw new SemaphoreFullError(this.waiters.length);
      await new Promise<void>((resolve) => this.waiters.push(resolve)); // slot-ыг release шууд бидэнд шилжүүлнэ
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next(); // active хэвээр (slot шилжсэн)
      else this.active--;
    }
  }
}

/** Ажлуудыг эхлэх дарааллаар нь хамгийн ихдээ `limit` зэрэг ажиллуулж, үр дүнг ижил дарааллаар буцаана. Аль нэг алдаатай бол эхний алдааг шиднэ. */
export async function mapLimit<T>(tasks: ReadonlyArray<() => Promise<T>>, limit: number): Promise<T[]> {
  const sem = new Semaphore(limit);
  return Promise.all(tasks.map((task) => sem.run(task)));
}
