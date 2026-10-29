// BSA ангилагчийн анхдагч тогтмолууд — НЭГ газар. Бизнесийн босго (дайчлах хувь, "Бусад" босго, ББӨ) энд БАЙХГҮЙ:
// тэд ангилал/тохиргооноос (BsaCategoryDef, BsaSettings) параметрээр ирнэ. Энд зөвхөн алгоритмын тогтмол + docs/02-д заасан анхдагч.

/** BSA-FR-3.1: итгэл % (0..100). docs/02 §5 "итгэл %". Ангилагч бүх оноог ЗӨВХӨН эндээс авна. */
export const CLASSIFY_CONFIDENCE = {
  /** Гар засвар (manualCategoryCode) */
  MANUAL: 100,
  /** COUNTERPARTY дүрэм: дансны дугаар/нэр яг таарсан */
  COUNTERPARTY: 95,
  /** KEYWORD дүрэм */
  KEYWORD: 85,
  /** KEYWORD бүтэн үг/хэллэгээр (хоёр захаараа үгийн хилтэй) таарвал нэмэх оноо */
  KEYWORD_WHOLE_PHRASE_BONUS: 5,
  /** REGEX дүрэм */
  REGEX: 80,
  /** source = FEEDBACK дүрэм (гар засвараас үүссэн) — match төрлөөс үл хамааран тогтмол */
  FEEDBACK: 85,
  /** Түлхүүр үггүй, зөвхөн суваг (QPAY/POS/ATM зарлага) → CHANNEL_EXPENSE */
  CHANNEL_FALLBACK: 60,
  /** Юу ч таарсангүй → OTHER_INCOME / OTHER_EXPENSE */
  UNMATCHED: 30,
} as const;

/** Дүрмийн priority-ийн зурвас (их утга түрүүлж). Анхдагч сан 100..399; FEEDBACK дунд; ADMIN дарах дүрэм ≥ 1000. */
export const RULE_PRIORITY = {
  /** Ерөнхий үг ('бараа', 'зээл', 'дэлгүүр') — бусад бүхэн давуу */
  WEAK: 100,
  NORMAL: 200,
  /** Тодорхой хэллэг (буцаалт, зээлийн эргэн төлөлт, бооцоо) — ерөнхий үгээс давуу */
  STRONG: 300,
  /** Гар засвараас санал болгосон дүрэм: анхдагчаас дээш, ADMIN дарах дүрмээс доош */
  FEEDBACK: 500,
  /** Admin-ы гараар тавьсан дарах дүрмийн санал болгох доод зурвас */
  ADMIN_OVERRIDE: 1000,
} as const;

/** Системийн ангиллын кодууд — ангилагч шууд оноодог тул ClassificationContext.categories-д ЗААВАЛ байх ёстой. */
export const SYSTEM_CATEGORY = {
  OWN_TRANSFER_INCOME: 'OWN_TRANSFER_IN',
  OWN_TRANSFER_EXPENSE: 'NON_EXPENSE',
  OTHER_INCOME: 'OTHER_INCOME',
  OTHER_EXPENSE: 'OTHER_EXPENSE',
  CHANNEL_EXPENSE: 'CHANNEL_EXPENSE',
} as const;

/** docs/02 §4: "Бусад" ангиллын бүлгийн код (BSA-BR-7) */
export const OTHER_GROUP_CODE = '?';

/** Түлхүүр үг тааруулах тогтмол (rule-engine, channel) */
export const MATCHING_DEFAULTS = {
  /**
   * Түлхүүр хэллэгийн сүүлийн үгийн (toMatchKey араг ясны) урт ≥ энэ бол үгийн төгсгөлд нөхцөл залгаж болно
   * ('цалин' → 'цалингийн'). Богино үг ('ус', 'хүү', 'pos', 'atm') зөвхөн бүтэн үгээр таарна ('мусак', 'хүүхэд' таарахгүй).
   */
  minPrefixWordLength: 4,
  /** Таарах текстийн дээд урт: гүйлгээний утга энээс урт бол тайрна (CPU хамгаалалт) */
  maxTextLength: 1000,
} as const;

/** REGEX дүрмийн аюулгүй байдлын хязгаар (regex-guard.ts) */
export const REGEX_LIMITS = {
  maxPatternLength: 200,
  /** Regex-д өгөх текстийн дээд урт (шугаман биш дүрэм ч O(L^k) хязгаартай байлгана) */
  maxInputLength: 300,
  /** Хязгааргүй давталтын (`*`, `+`, `{n,}`) дээд тоо: backtracking нь O(L^k)-аар хязгаарлагдана */
  maxUnboundedQuantifiers: 2,
  /** `{n,m}`-ийн m-ийн дээд утга */
  maxBoundedRepeat: 100,
} as const;

/** BSA-BR-5: өөрийн данс хоорондын шилжүүлэг илрүүлэх анхдагч (docs/02 §4 BSA-BR-5) */
export const OWN_TRANSFER_DEFAULTS = {
  /** Хуулгад цаг байхгүй банкууд → хос тааруулахад цаг минут шаардахгүй (docs/02 BSA-BR-5) */
  timeExemptBanks: ['GOLOMT', 'XAC', 'CAPITRON'] as readonly string[],
  /** Утганд харилцагчийн нэр байвал өөрийн данс гэж үзэх банк (docs/02 BSA-BR-5: Голомт) */
  nameInDescriptionBanks: ['GOLOMT'] as readonly string[],
  /** Далдалсан дансны ('50****4567') сүүлийн цифрийн доод урт */
  minMaskedSuffixDigits: 4,
  /** IBAN ↔ дотоодын дансны дугаар (сүүлийн цифрээр) харьцуулах доод урт */
  minIbanTailDigits: 8,
  /** Хос хайх бүлэг (огноо+дүн) тус бүрийн нэг талын дээд тоо — O(n²) хамгаалалт */
  maxPairGroupSide: 500,
  /** Нэрийн үгсийн хоорондох зөвшөөрөх завсрын үгийн тоо */
  maxNameWordGap: 2,
  /** Нэр хэдэн үгтэй байж "бүтэн нэр" болох (нэг үгтэй нэрийг ('Болд') таамаглахгүй) */
  minNameTokens: 2,
  /** Нэрний үг энэ уртаас богино бол (эхний үсэг) тооцохгүй */
  minNameTokenLength: 2,
} as const;

/** Өөрийн данс илрүүлэлтийн итгэл % */
export const OWN_TRANSFER_CONFIDENCE = {
  ACCOUNT_EXACT: 95,
  ACCOUNT_MASKED: 80,
  /** Хос: огноо + дүн + цаг минут таарсан */
  PAIR_TIME_VERIFIED: 90,
  /** Хос: цаг шалгагдаагүй (Голомт/Хас/Капитрон эсвэл цаг байхгүй) */
  PAIR_TIME_UNVERIFIED: 75,
  /** Голомт: утганд нэр — "бага итгэл" */
  NAME_IN_DESCRIPTION: 60,
} as const;

/** Гар засвар → ижил утгад санал болгох (reclassify.ts) */
export const RECLASSIFY_DEFAULTS = {
  /** Утгын "үндэс" (тоо/огноо хассаны дараа) энээс богино бол ерөнхийлөхгүй */
  minStemLength: 3,
  /** Тоо хассаны дараа үлдсэн үсгийн тоо энээс бага үгийг хаяна ('ab123' → хаяна) */
  minTokenLetters: 2,
} as const;
