// UN-ийн жагсаалт иргэншил, олгосон улсыг англи нэрээр ("Russian Federation") өгдөг; AML screening ISO 3166-1 alpha-2 кодоор тулгана.
// Суурь хүснэгт = ICU-ийн Intl.DisplayNames (бүх AA..ZZ), дээр нь UN/ICU-ийн нэрийн зөрүүг тодорхой alias-аар нөхнө.
// Танигдахгүй нэр ("na", "former Soviet Union", үл мэдэгдэх) → null: код зохиож өгөхгүй (хуурамч иргэншлээр буруу тулгалт хийхээс сэргийлнэ).
// Бодит файлын бүх нэр танигдахыг un-consolidated.parser.test.ts шалгана — ICU-ийн нэр солигдвол тэнд эхэлж унана.

/** Нэрийг харьцуулах хэлбэрт оруулна: жижиг үсэг, диакритикгүй, "&" → "and", зайг нэгтгэнэ. */
function normalizeCountryName(name: string): string {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim();
}

// UN-ийн албан ёсны нэр (болон түгээмэл хувилбар) → код. Түлхүүрүүд normalizeCountryName-ээр нормчлогдсон.
const UN_ALIASES: Readonly<Record<string, string>> = {
  'bosnia and herzegovina': 'BA', 'trinidad and tobago': 'TT', 'congo': 'CG', 'democratic republic of the congo': 'CD', 'democratic republic of congo': 'CD',
  "democratic people's republic of korea": 'KP', 'republic of korea': 'KR', 'iran (islamic republic of)': 'IR', 'russian federation': 'RU',
  'state of palestine': 'PS', 'syrian arab republic': 'SY', 'united kingdom of great britain and northern ireland': 'GB',
  'united republic of tanzania': 'TZ', 'united states of america': 'US', 'turkiye': 'TR', 'turkey': 'TR', 'viet nam': 'VN',
  "lao people's democratic republic": 'LA', 'republic of moldova': 'MD', 'bolivia (plurinational state of)': 'BO',
  'venezuela (bolivarian republic of)': 'VE', "cote d'ivoire": 'CI', 'czechia': 'CZ', 'czech republic': 'CZ', 'north macedonia': 'MK',
  'eswatini': 'SZ', 'brunei darussalam': 'BN', 'cabo verde': 'CV', 'cape verde': 'CV', 'micronesia (federated states of)': 'FM', 'myanmar': 'MM',
};

let table: Map<string, string> | undefined;

function buildTable(): Map<string, string> {
  const map = new Map<string, string>();
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  for (let a = 65; a <= 90; a += 1) {
    for (let b = 65; b <= 90; b += 1) {
      const code = String.fromCharCode(a, b);
      let display: string | undefined;
      try { display = names.of(code); } catch { display = undefined; } // хүчингүй код → RangeError
      if (display && display !== code) map.set(normalizeCountryName(display), code);
    }
  }
  for (const [name, code] of Object.entries(UN_ALIASES)) map.set(name, code);
  return map;
}

export function isoAlpha2FromCountryName(name: string | undefined | null): string | null {
  if (typeof name !== 'string') return null;
  const key = normalizeCountryName(name);
  if (!key) return null;
  table ??= buildTable();
  return table.get(key) ?? null;
}
