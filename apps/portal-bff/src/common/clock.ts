export const CLOCK = Symbol('CLOCK');

/** Цаг дамжуулах порт: токен/OTP/ЭТХ-ийн хугацааг тестэд тодорхой болгоно. */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
