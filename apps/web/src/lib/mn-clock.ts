import { mnDateKey } from './format';
// Улаанбаатарын (UTC+8, DST байхгүй) өдөр солигдохыг дагах цэвэр туслах. Нээлттэй үлдсэн дэлгэц (кассын терминал) шөнө дундыг давахад "өнөөдөр" цонх хуучирч гацахгүй байлгана.

const DAY_MS = 86_400_000;
const MN_OFFSET_MS = 8 * 3_600_000;
/** Нойрсож/throttle болсон төхөөрөмж, цаг тохируулгын дараа ч өдрийг дор хаяж минут тутам дахин шалгана. */
const MAX_WAIT_MS = 60_000;
/** Шөнө дундаас хойш бага зэрэг хүлээнэ (timer эрт өртөхөөс сэргийлнэ). */
const SLACK_MS = 50;

/** Дараагийн Улаанбаатарын шөнө дунд хүртэлх миллисекунд (яг шөнө дунд бол 24 цаг). */
export function msUntilMnMidnight(now: Date): number {
  const local = now.getTime() + MN_OFFSET_MS;
  return DAY_MS - (((local % DAY_MS) + DAY_MS) % DAY_MS);
}

/**
 * Улаанбаатарын огноо ('YYYY-MM-DD') өөрчлөгдөх бүрд `onChange(key)` дуудна. Эхний утгыг дуудахгүй.
 * Дараагийн шөнө дунд хүртэл (дээд тал нь минут) timeout тавина; таб дахин харагдахад (visibilitychange) шууд шалгана. Буцаах функц зогсооно.
 */
export function watchMnDateKey(onChange: (key: string) => void, now: () => Date = () => new Date()): () => void {
  let last = mnDateKey(now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    const key = mnDateKey(now());
    if (key !== last) {
      last = key;
      onChange(key);
    }
  };
  const arm = () => {
    timer = setTimeout(() => {
      check();
      arm();
    }, Math.min(MAX_WAIT_MS, msUntilMnMidnight(now()) + SLACK_MS));
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') check();
  };
  arm();
  const hasDocument = typeof document !== 'undefined';
  if (hasDocument) document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearTimeout(timer);
    if (hasDocument) document.removeEventListener('visibilitychange', onVisible);
  };
}
