// Jaro-Winkler ижил байдал (стандарт): scaling 0.1, prefix дээд тал нь 4, jaro > 0.7 үед л boost.
const PREFIX_SCALE = 0.1;
const PREFIX_CAP = 4;
const BOOST_ABOVE = 0.7;

// Хугацаа хамгийн их зарцуулагддаг функц (токен хос бүрт): тэмдэглэгээний массивыг дуудлага бүрт шинээр үүсгэхгүй, нэг scratch буферийг
// дахин ашиглана (синхрон, нэг thread — дуудлага хоорондоо давхцахгүй).
let matchedA = new Uint8Array(64);
let matchedB = new Uint8Array(64);

/**
 * Jaro. minMatches > 0 үед таарсан тэмдэгтийн тоо түүнээс бага байх нь тодорхой болмогц 0 буцаана (оноо нь аль хэдийн босгоос
 * доор). minMatches-аас дээш таарсан хосын утга яг стандарт Jaro.
 */
function jaro(a: readonly string[], b: readonly string[], minMatches: number): number {
  if (matchedA.length < a.length) matchedA = new Uint8Array(a.length * 2);
  if (matchedB.length < b.length) matchedB = new Uint8Array(b.length * 2);
  matchedA.fill(0, 0, a.length);
  matchedB.fill(0, 0, b.length);
  const window = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    // Үлдсэн тэмдэгтүүд бүгд таарсан ч minMatches-д хүрэхгүй бол цааш тооцох хэрэггүй
    if (matches + (a.length - i) < minMatches) return 0;
    const end = Math.min(i + window, b.length - 1);
    for (let j = Math.max(i - window, 0); j <= end; j++) {
      if (matchedB[j] === 0 && a[i] === b[j]) {
        matchedA[i] = 1;
        matchedB[j] = 1;
        matches++;
        break;
      }
    }
  }
  if (matches === 0 || matches < minMatches) return 0;

  // Таарсан тэмдэгтүүдийн дараалал зөрсөн тоо / 2 = transposition
  let misordered = 0;
  for (let i = 0, j = 0; i < a.length; i++) {
    if (matchedA[i] === 0) continue;
    while (matchedB[j] === 0) j++;
    if (a[i] !== b[j]) misordered++;
    j++;
  }
  const transpositions = misordered / 2;
  return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
}

/**
 * Jaro-Winkler босго `floor` хүрэхэд ЗААВАЛ шаардагдах таарсан тэмдэгтийн доод тоо (m). JW ≥ floor ⇒ jaro ≥ jMin, харин
 * jaro ≤ (m / |a| + m / |b| + 1) / 3 тул m ≥ (3 · jMin − 1) · |a| · |b| / (|a| + |b|). jMin: floor > 0.7 үед boost (prefix ≤ 4)
 * хамгийн ихдээ 0.4 · (1 − jaro) тул jaro ≥ (floor − 0.4) / 0.6, мөн boost зөвхөн jaro > 0.7 үед. Ийм доод тоо хүрэхгүй хос хэзээ ч
 * floor-д хүрэхгүй (тооцооллын алдаанд 1e-9 нөөцтэй).
 */
function minMatchesFor(floor: number, lengthA: number, lengthB: number): number {
  const boostCeiling = PREFIX_CAP * PREFIX_SCALE;
  const jMin = floor > BOOST_ABOVE ? Math.max(BOOST_ABOVE, (floor - boostCeiling) / (1 - boostCeiling)) : floor;
  return Math.max(Math.ceil(((3 * jMin - 1) * lengthA * lengthB) / (lengthA + lengthB) - 1e-9), 1);
}

/**
 * Код цэгийн массив дээр ажиллах хувилбар: нэг токеныг олон удаа харьцуулахад мөр бүрийг дахин задлахгүй
 * (name-similarity токеныг нэг удаа задлаад цэгийн массиваар нь дамжуулна).
 * floor өгвөл (хос нь зөвхөн floor-оос дээш бол хэрэгтэй үед) floor-д хүрэхгүй нь тодорхой хосыг тооцохоо болиод 0 буцаана;
 * floor-д хүрэх хосын утга яг стандарт JW. floor өгөөгүй бол үргэлж яг стандарт утга.
 */
export function jaroWinklerCodePoints(x: readonly string[], y: readonly string[], floor = 0): number {
  if (x.length === 0 || y.length === 0) return 0;
  const minMatches = floor > 0 ? minMatchesFor(floor, x.length, y.length) : 0;
  if (minMatches > Math.min(x.length, y.length)) return 0;
  const base = jaro(x, y, minMatches);
  if (base <= BOOST_ABOVE) return base;
  let prefix = 0;
  const limit = Math.min(PREFIX_CAP, x.length, y.length);
  while (prefix < limit && x[prefix] === y[prefix]) prefix++;
  return base + prefix * PREFIX_SCALE * (1 - base);
}

/** 0..1. Тэнцүү хоосон биш мөр = 1; аль нэг нь хоосон = 0. Аргумент солигдоход утга өөрчлөгдөхгүй. */
export function jaroWinkler(a: string, b: string): number {
  if (a === '' || b === '') return 0;
  if (a === b) return 1;
  // Код цэгээр харьцуулна (surrogate pair-ийг хуваахгүй)
  return jaroWinklerCodePoints([...a], [...b]);
}
