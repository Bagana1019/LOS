import { Clock } from '../ports';

/** Тестэд цагийг гараар удирдана. Анхдагч: 2026-10-28 12:00 Улаанбаатар (04:00Z). */
export class FakeClock extends Clock {
  private current: Date;
  constructor(start: Date | string = '2026-10-28T04:00:00.000Z') {
    super();
    this.current = new Date(start);
  }
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(to: Date | string): this {
    this.current = new Date(to);
    return this;
  }
  advanceMs(ms: number): this {
    this.current = new Date(this.current.getTime() + ms);
    return this;
  }
  advanceSeconds(s: number): this {
    return this.advanceMs(s * 1000);
  }
  advanceMinutes(m: number): this {
    return this.advanceMs(m * 60_000);
  }
  advanceHours(h: number): this {
    return this.advanceMs(h * 3_600_000);
  }
}
