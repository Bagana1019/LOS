import { OtpGenerator } from '../../ports';

/** DEMO/TEST-ийн тогтмол OTP (docs/05 §11). */
export const DEMO_OTP = '123456';

/** DEMO/TEST: тогтмол код (docs/05 §11). Production-д RandomOtpGenerator. */
export class FixedOtpGenerator extends OtpGenerator {
  constructor(private readonly code = DEMO_OTP) { super(); }
  next(): string {
    return this.code;
  }
}
