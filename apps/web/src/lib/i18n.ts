import { mn, t } from '@los/ui/src/i18n/mn';
// UI текст зөвхөн монгол кирилл (docs/05 §12). Хавтгай түлхүүр: 'merchant.*', 'pos.status.<STATUS>', 'error.<CODE>', 'payment.*' ...
// Түлхүүр дутвал түлхүүрийг өөрийг нь буцаана (UI хоосон болохоос сэргийлнэ); i18n.test.ts дутагдлыг барина.

export type MessageParams = Record<string, string | number>;

const messages: Record<string, string> = mn;

export function hasMessage(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(messages, key);
}

export function messageKeys(): string[] {
  return Object.keys(messages);
}

/** t('payment.title') · t('payment.due', { date: '2026-10-28' }) — `{name}` placeholder-ыг params-аар солино; params-д байхгүй placeholder хэвээр үлдэнэ. Нэг хэрэгжилт: `@los/ui`-ийн `t`. */
export { t };

export const formatMoney = (n: number, currency = 'MNT') => `${new Intl.NumberFormat('mn-MN', { maximumFractionDigits: 2 }).format(n)} ${currency === 'MNT' ? '₮' : currency}`;
