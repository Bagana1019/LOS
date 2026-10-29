// Хязгаартай Levenshtein зай (Ukkonen-ийн зурвас): зай нь limit-ээс их бол null. O(n × limit) — урт нэр, олон хос дээр
// квадрат зардал гаргахгүй. Үгийн хил хязгаар зөрсөн нэрийг (залгасан хэлбэр) харьцуулахад ашиглана.

/** x, y код цэгийн массив. Зай ≤ limit бол зай, үгүй бол null. */
export function boundedLevenshtein(x: readonly string[], y: readonly string[], limit: number): number | null {
  const n = x.length;
  const m = y.length;
  if (Math.abs(n - m) > limit) return null;
  const INF = limit + 1;
  let prev = new Array<number>(m + 2).fill(INF);
  let cur = new Array<number>(m + 2).fill(INF);
  for (let j = 0; j <= Math.min(m, limit); j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    const lo = Math.max(1, i - limit);
    const hi = Math.min(m, i + limit);
    cur[lo - 1] = lo === 1 ? Math.min(i, INF) : INF;
    let rowMin = cur[lo - 1];
    for (let j = lo; j <= hi; j++) {
      const v = Math.min(prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1), prev[j] + 1, cur[j - 1] + 1, INF);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (hi < m) cur[hi + 1] = INF; // дараагийн мөр зурвасаас гарсан баруун талын нүдийг INF гэж уншина
    if (rowMin > limit) return null;
    [prev, cur] = [cur, prev];
  }
  return prev[m] <= limit ? prev[m] : null;
}

/**
 * 1 − зай / урт; зай нь floor-оос доош ижилсэлд хүргэх бол 0. Тэгш хэмтэй. maxDistance өгвөл зөвшөөрөх засварын тоог түүнээс ихгүй
 * болгоно (floor-оос хатуу хязгаар): жишээ нь урт нэрэнд floor 0.8 нь олон засвар зөвшөөрдөг ч хил хязгаарын шилжилтэд 1 засвар л хангалттай.
 */
export function editSimilarity(x: readonly string[], y: readonly string[], floor: number, maxDistance = Number.POSITIVE_INFINITY): number {
  const longest = Math.max(x.length, y.length);
  if (longest === 0) return 0;
  // 1e-9: floor = 0.8 үед floating-point нь (1 − 0.8) × 10 = 1.9999… болгож нэг засварыг алдахаас сэргийлнэ
  const limit = Math.min(Math.floor((1 - floor) * longest + 1e-9), maxDistance);
  const distance = boundedLevenshtein(x, y, limit);
  return distance === null ? 0 : 1 - distance / longest;
}
