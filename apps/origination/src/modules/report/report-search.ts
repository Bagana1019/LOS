/**
 * F11-3: хайлтын үгсийг unicode хоосон зайгаар (зай, tab, мөр шилжилт, NBSP…) салгана; давхардсан үгийг нэгтгэнэ (SQL нөхцөл давтагдахгүй).
 * Том/жижиг үсгийг хэвээр үлдээнэ — хайлтыг SQL талд ILIKE хийнэ. Хоосон/зөвхөн хоосон зай → [].
 */
export const searchWords = (term: string): string[] => [...new Set(term.split(/\s+/u).filter(Boolean))];
