import { randomInt } from 'crypto';
import { OtpGenerator } from '../../ports';

export class RandomOtpGenerator extends OtpGenerator {
  next(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }
}
