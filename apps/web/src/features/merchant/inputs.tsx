'use client';
import { InputNumber, type InputNumberProps } from 'antd';
import type { Rule } from 'antd/es/form';
import { t } from '../../lib/i18n';

/** Төгрөгийн дээд хязгаар (contracts `Money.max`). Хязгаарыг InputNumber-д БИШ, form rule-д (`mntMaxRule`) тавина. */
export const MAX_MNT = 1_000_000_000_000;

/**
 * ЧУХАЛ: энд InputNumber-ийн `min`/`max` тавихгүй. antd нь хязгаараас гарсан утгыг blur дээр чимээгүй clamp хийдэг
 * (комисс 25 → 20, өдрийн лимит 0 → 1₮) тул form-ын rule-ийн монгол алдааны мессеж хэзээ ч харагдахгүй байсан. Хязгаарыг зөвхөн `rules`-д тавина.
 */

export const mntFormatter = (v: string | number | undefined): string => (v === undefined || v === null || v === '' ? '' : String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ','));

/**
 * Төгрөгийн оролтыг бүхэл тоо болгоно (цифрийн мөр). Мянгатын таслал, зай, апостроф хасагдана; аравтын тэмдэгтийн ХОЙШХИ хэсэг хаягдана —
 * '2,000,000.00' → '2000000' (өмнө нь 200000000 болж 100 дахин алдаж байсан). Бүх бүтэн тоо хэвээр: '2 000 000' → '2000000'.
 * Аравтын тэмдэгт: '.' ба ',' хоёул байвал сүүлд орсон нь; зөвхөн '.' бол нэг л удаа орсон үед; зөвхөн ',' бол нэг удаа орж, дараа нь 1–2 цифртэй үед ('2000000,5').
 * Олон '.' (2.000.000) эсвэл 3 цифртэй ',' бүлэг (1,500) нь мянгатын тусгаарлагч. Тоо биш тэмдэгт хаягдана; цифр байхгүй бол ''.
 */
export function mntParser(raw: string | undefined | null): string {
  const s = (raw ?? '').replace(/[\s'’]/g, ''); // \s нь NBSP/нарийн зайг ч хамарна
  const dots = s.split('.').length - 1;
  const commas = s.split(',').length - 1;
  let decimalAt = -1;
  if (dots > 0 && commas > 0) decimalAt = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  else if (dots === 1) decimalAt = s.indexOf('.');
  else if (commas === 1 && /,\d{1,2}$/.test(s)) decimalAt = s.indexOf(',');
  const digits = (decimalAt === -1 ? s : s.slice(0, decimalAt)).replace(/\D/g, '');
  // Сөрөг тэмдгийг чимээгүй хасахгүй (-1,500 → 1500 болохгүй): form-ын min rule алдаа үзүүлнэ.
  return digits !== '' && /^[-−–]/.test(s) ? `-${digits}` : digits;
}

/** `{ type: 'number', max }` — дээд хязгаарыг (clamp хийхгүйгээр) мессежтэй шалгана. */
export const mntMaxRule = (): Rule => ({ type: 'number', max: MAX_MNT, message: t('validation.amountMax') });

/** Төгрөгийн оролт: мянгатын таслал, бүхэл тоо, ₮ дагавар. Хязгаарыг form `rules`-д (+ `mntMaxRule`) тавина. */
export function MntInput(props: InputNumberProps<number>) {
  return <InputNumber<number> className="mp-input-full" controls={false} inputMode="numeric" precision={0} formatter={mntFormatter} parser={mntParser as unknown as InputNumberProps<number>['parser']} suffix="₮" {...props} />;
}

/** Хувийн оролт (хэрэглэгч 2.5 гэж бичнэ; API-д бутархай `percentToRate`-аар). Хязгаарыг form `rules`-д тавина. */
export function PercentInput(props: InputNumberProps<number>) {
  return <InputNumber<number> className="mp-input-full" controls={false} inputMode="decimal" precision={2} suffix="%" {...props} />;
}

/** Бүхэл тооны оролт (хоног, нас, оноо). */
export function IntInput(props: InputNumberProps<number>) {
  return <InputNumber<number> className="mp-input-full" controls={false} inputMode="numeric" precision={0} {...props} />;
}
