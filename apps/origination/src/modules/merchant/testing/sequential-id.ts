import { CROCKFORD_ALPHABET } from '../common/ids';
import { IdGenerator } from '../ports';

/** Тестэд тодорхойлогдох ID: зөв хэлбэртэй UUID (zod .uuid()) ба дараалсан 6 тэмдэгтийн суффикс. */
export class SequentialIdGenerator extends IdGenerator {
  private u = 0;
  private s = 0;
  /** Дараагийн `leaseSuffix()` дуудлагуудад буцаах утгууд (LEASE_NO давхцлыг туршихад) */
  readonly forcedSuffixes: string[] = [];
  uuid(): string {
    return `00000000-0000-4000-8000-${String(++this.u).padStart(12, '0')}`;
  }
  leaseSuffix(): string {
    const forced = this.forcedSuffixes.shift();
    if (forced !== undefined) return forced;
    let n = ++this.s;
    let out = '';
    while (out.length < 6) {
      out = CROCKFORD_ALPHABET[n % 32] + out;
      n = Math.floor(n / 32);
    }
    return out;
  }
}
