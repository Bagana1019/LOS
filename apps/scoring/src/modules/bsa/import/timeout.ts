// Импортын хугацааны хамгаалалт. JS-д ажиллаж буй promise-г цуцлах боломжгүй тул `withTimeout` нь хариуг л орхино (OCR/PDF-ийн async алхамд);
// синхрон CPU ажил (parse/classify) дунд нь тасалж чадахгүй тул `Deadline.check` алхам хоорондоо шалгана.
export class ImportTimeoutError extends Error {
  constructor(readonly step: string) {
    super(`import step "${step}" timed out`);
    this.name = 'ImportTimeoutError';
  }
}

export function withTimeout<T>(work: Promise<T>, ms: number, step: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ImportTimeoutError(step)), ms);
  });
  // timeout түрүүлбэл work-ийн дараагийн reject дарагдаж unhandled rejection болохгүй
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Нийт ажлын эцсийн хугацаа. `now` нь тестэд тогтмол цаг шахахад */
export class Deadline {
  readonly #endsAt: number;
  constructor(totalMs: number, private readonly now: () => number = Date.now) {
    this.#endsAt = now() + totalMs;
  }
  remainingMs(): number {
    return Math.max(0, this.#endsAt - this.now());
  }
  check(step: string): void {
    if (this.now() > this.#endsAt) throw new ImportTimeoutError(step);
  }
}
