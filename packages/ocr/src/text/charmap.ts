// Монгол текстийн нийтлэг үсгийн хүснэгтүүд — НЭГ газар (README.md-д тайлбарласан). NFR-9: кирилл/латин холимог утга таних.
// Энд зөвхөн өгөгдөл (хүснэгт, дүрэм); логик нь script.ts / match-key.ts-д.

/**
 * Кирилл (жижиг үсэг) → латин араг яс (skeleton). MNS 5217-тэй төстэй боловч албан бус бичлэгт ээлтэй:
 * ө,у,ү→o,u,u; ё,е,э→o,e,e; й,ы→i; ъ,ь→''. Үр дүн нь зөвхөн тааруулах түлхүүр — үзүүлэхэд тохиромжгүй.
 */
export const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'o', ж: 'j', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', ө: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ү: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // Бусад кирилл (украин/казах) — зөвхөн OCR-ийн алдааг тэсвэрлэх зорилгоор
  і: 'i', ї: 'i', є: 'e', ґ: 'g', ў: 'u', ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ұ: 'u', һ: 'h',
};

/** Латин ↔ кирилл харагдацаараа ижил үсгүүд (том/жижиг тусдаа; B→В, H→Н, K→К, M→М, T→Т зөвхөн том үсгээр). */
export const LATIN_TO_CYRILLIC_LOOKALIKE: Readonly<Record<string, string>> = {
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
  a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у',
};

/** Урвуу чиглэл: латин үгийн дотор орсон кирилл look-alike-ыг латин руу буцаана (OCR `mon+eng`). */
export const CYRILLIC_TO_LATIN_LOOKALIKE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(LATIN_TO_CYRILLIC_LOOKALIKE).map(([latin, cyr]) => [cyr, latin]),
);

/** Давхар үсгийг нэг болгоно: урт эгшиг/давхар гийгүүлэгч aa→a, ii→i, ll→l (латин [a-z]) */
const COLLAPSE_RULE: readonly [RegExp, string] = [/([a-z])\1+/g, '$1'];

/**
 * Латин бичлэгийн хувилбаруудыг нэг араг ясанд нийлүүлэх дүрэм. Дарааллаар, тогтворжтол давтан хэрэглэнэ (idempotent).
 * Жишээ: Khan/Xaan → han; Zhargal → jargal; Wang → vang; Xac → has; Capitron → kapitron; Yondon → ondon; Baatar/Batar → batar.
 * `ch` хамгаалагдана (ч). Латин `c` хоёрдмол: а/о/у/к/л/р-ийн өмнө = к (Capitron = Капитрон), бусад = с (Xac = Хас).
 * Кирилл үгэн доторх латин c (look-alike) нь холимог үгийн алхамд с болж өмнө нь шийдэгдсэн байна.
 * Давхар үсгийн нугалалт эхэнд ба төгсгөлд: `kkkkh` мэт урт давталт `k+h` regex-гүйгээр (O(n²) backtracking-ээс сэргийлж) нэг дамжилтад багтана.
 */
export const LATIN_FOLD_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  COLLAPSE_RULE,
  [/x/g, 'h'], // х: x → h (XacBank)
  [/w/g, 'v'], // в: w → v
  [/kh/g, 'h'], // х: kh → h (MNS 5217)
  [/zh/g, 'j'], // ж: zh → j
  [/c(?=[aouklr])/g, 'k'], // нугарамтгай c (Capitron, Cash, Club, Black) = к
  [/c(?!h)/g, 's'], // бусад c = с look-alike (Xac, Citi); `ch` (ч) хэвээр
  [/ye/g, 'e'], // е: ye → e
  [/yo/g, 'o'], // ё: yo → o
  [/y(?![au])/g, 'i'], // й/ы: ay, iy, y$ → i; харин ya, yu (я, ю) хэвээр
  COLLAPSE_RULE,
];

/** Үл үзэгдэх тэмдэгтүүд: soft hyphen, zero-width space/joiner/non-joiner, word joiner, BOM. */
export const INVISIBLE_CHARS_RE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

/** Үгийн дундах apostrophe-ууд (ъ/ь-ийн латин тэмдэглэгээ) — зайгаар биш, устгана. */
export const APOSTROPHE_CHARS_RE = /['\u2018\u2019\u02BC`\u00B4]/g;
