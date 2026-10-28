/** Тестэд цаг тогтоохын тулд `new Date()`-ийг шууд дуудахгүй. */
export abstract class Clock { abstract now(): Date }
export class SystemClock extends Clock { now(): Date { return new Date(); } }
export class FixedClock extends Clock {
  constructor(private at: Date) { super(); }
  now(): Date { return new Date(this.at); }
  set(at: Date) { this.at = at; }
}
