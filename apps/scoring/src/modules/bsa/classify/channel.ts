// BSA-FR-3.1 / docs/02 §2: гүйлгээний суваг таних (QPay / POS / ATM / шилжүүлэг). Түлхүүр үгийг НЭГ удаа кирилл хэлбэрээр бичнэ —
// латин/холимог бичлэгийг toMatchKey нэг түлхүүр болгоно (NFR-9).
import type { TxnChannel } from '@los/contracts';
import { MATCHING_DEFAULTS } from './classify.defaults';
import type { ClassifiableTxn } from './classify.types';
import { FIELD_SEPARATOR, matchKey } from './normalize';
import { lastWordLength, matchPhrase } from './text-match';

type KeywordChannel = Exclude<TxnChannel, 'OTHER'>;

/**
 * Сувгийн түлхүүр үгс. Шалгах дараалал нь CHANNEL_ORDER (ATM → QPAY → POS → TRANSFER): тодорхой түлхүүр үгтэй суваг
 * ерөнхий "шилжүүлэг"-ээс давуу. TODO(samples): бодит хуулгын формат ирмэгц банк бүрийн утгын үгсийг нэмж баталгаажуулна.
 */
export const CHANNEL_KEYWORDS: Readonly<Record<KeywordChannel, readonly string[]>> = {
  ATM: [
    'atm', 'атм', 'банкомат', 'бэлэн мөнгө авсан', 'бэлэн мөнгө авалт', 'бэлэн мөнгө татсан', 'бэлэн мөнгө гаргасан',
    'бэлнээр авсан', 'cash withdrawal', 'cash out', 'cash advance',
  ],
  // SocialPay нь QR төлбөрийн хэтэвч тул enum-д тусдаа утга байхгүй учир QPAY-д нэгтгэв (DECISIONS)
  QPAY: ['qpay', 'q pay', 'кюпэй', 'кьюпэй', 'socialpay', 'social pay', 'сошиал пэй'],
  POS: ['pos', 'пос', 'терминал'],
  TRANSFER: ['шилжүүлэг', 'шилжүүлсэн', 'шилжилт', 'transfer', 'интернет банк', 'ibank', 'мобайл банк'],
};

export const CHANNEL_ORDER: readonly KeywordChannel[] = ['ATM', 'QPAY', 'POS', 'TRANSFER'];

interface CompiledChannelPhrase {
  phrase: string;
  prefixAllowed: boolean;
}
type CompiledChannelKeywords = Array<{ channel: KeywordChannel; phrases: CompiledChannelPhrase[] }>;

function compileChannelKeywords(keywords: Readonly<Record<KeywordChannel, readonly string[]>>): CompiledChannelKeywords {
  return CHANNEL_ORDER.map((channel) => ({
    channel,
    phrases: (keywords[channel] ?? [])
      .map((k) => matchKey(k))
      .filter((phrase) => phrase !== '')
      .map((phrase) => ({ phrase, prefixAllowed: lastWordLength(phrase) >= MATCHING_DEFAULTS.minPrefixWordLength })),
  }));
}

const DEFAULT_COMPILED = compileChannelKeywords(CHANNEL_KEYWORDS);

/** Нормчилсон `haystack` (prepareTxn-ий гаралт) дээр суваг тодорхойлно. Классификатор энийг дуудна. */
export function channelOfHaystack(
  haystack: string,
  hasCounterpartyAccount: boolean,
  compiled: CompiledChannelKeywords = DEFAULT_COMPILED,
): TxnChannel {
  for (const { channel, phrases } of compiled) {
    if (channel === 'TRANSFER' && hasCounterpartyAccount) return 'TRANSFER'; // харьцсан данс байвал шилжүүлэг (түлхүүр үг хүлээхгүй)
    for (const { phrase, prefixAllowed } of phrases) if (matchPhrase(haystack, phrase, prefixAllowed)) return channel;
  }
  return 'OTHER';
}

export type ChannelInput = Pick<ClassifiableTxn, 'description' | 'counterpartyAccount' | 'counterpartyName'>;

/**
 * Суваг таних: ATM → QPAY → POS → TRANSFER (харьцсан данс байгаа эсвэл 'шилжүүлэг' гэх мэт үг) → OTHER.
 * `keywords`-оор өөр жагсаалт өгч болно (тест/admin); анхдагч нь CHANNEL_KEYWORDS.
 */
export function detectChannel(txn: ChannelInput, keywords?: Readonly<Record<KeywordChannel, readonly string[]>>): TxnChannel {
  const haystack = `${matchKey(txn.description)}${FIELD_SEPARATOR}${matchKey(txn.counterpartyName)}`;
  const hasAccount = typeof txn.counterpartyAccount === 'string' && txn.counterpartyAccount.trim() !== '';
  return channelOfHaystack(haystack, hasAccount, keywords ? compileChannelKeywords(keywords) : DEFAULT_COMPILED);
}
