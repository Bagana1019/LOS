import type { AmlHit } from '@los/contracts';
import type { StoredScreening } from './aml.ports';
import { subjectIdentityKey } from './subject-identity';

/** Өмнөх шийдвэрийг шинэ hit-д шилжүүлэх: status / reviewedBy / reviewedAt (анхных, дахин тамгалахгүй) / reviewComment + details.carriedOverFrom. */
function inherit(hit: AmlHit, prior: AmlHit): AmlHit {
  return {
    ...hit, status: prior.status, reviewedBy: prior.reviewedBy, reviewedAt: prior.reviewedAt, reviewComment: prior.reviewComment,
    details: { ...hit.details, carriedOverFrom: prior.id },
  };
}

/**
 * Дахин шалгалтад өмнөх шийдвэрийг дамжуулах (FR-3.4). Зөвхөн харилцагчийн ӨМНӨХ сүүлийн шалгалтаас, registerNoHash ижил үед:
 *  - CONFIRMED: ижил (list, entryRef)-тэй БҮХ шинэ hit CONFIRMED-ийг өвлөнө — matchType / нотолгоо өөрчлөгдсөн ч (баталгаажсан хоригийг ганц
 *    reviewer нэрийн тохирол солигдсоны улмаас цэвэрлэж болохгүй). Шалгалтад hit огт гарахаа больсон бол (жагсаалтаас хасагдсан) CONFIRMED
 *    алга болно — мэдэгдсэн хязгаарлалт; блоклосон харилцагчийн identity-г солихыг service-ийн guard (409) урьдчилан хаадаг.
 *  - FALSE_POSITIVE: identity түлхүүр, matchType, details.evidenceDigest гурвуулаа тэнцүү үед л. Өөрөөр шинэ hit OPEN хэвээр үлдэж
 *    details.reopenedBecause = 'EVIDENCE_CHANGED' авна (нотолгоо хүчирхэгжсэн, FATF ангилал өссөн, төрсөн он таарсан гэх мэт).
 * Шийдвэргүй (OPEN) өмнөх hit-ийг дамжуулахгүй. Оролтыг өөрчлөхгүй.
 */
export function carryOverDecisions(previous: StoredScreening | null, registerNoHash: string, identityKey: string, hits: AmlHit[]): AmlHit[] {
  if (!previous || previous.registerNoHash !== registerNoHash) return hits;
  const decided = previous.hits.filter((h) => h.status !== 'OPEN');
  if (decided.length === 0) return hits;
  const sameIdentity = subjectIdentityKey(previous.subject) === identityKey;
  return hits.map((h) => {
    const sameEntry = decided.filter((d) => d.list === h.list && d.entryRef === h.entryRef);
    if (sameEntry.length === 0) return h;
    const confirmed = sameEntry.find((d) => d.status === 'CONFIRMED');
    if (confirmed) return inherit(h, confirmed);
    const digest = h.details['evidenceDigest'];
    const unchanged = sameEntry.find((d) => sameIdentity && d.matchType === h.matchType && typeof digest === 'string' && d.details['evidenceDigest'] === digest);
    if (unchanged) return inherit(h, unchanged);
    // Энд зөвхөн FALSE_POSITIVE шийдвэртэй (CONFIRMED дээр буцсан) байна: нотолгоо / identity өөрчлөгдсөн тул дахин хянуулна.
    return { ...h, details: { ...h.details, reopenedBecause: 'EVIDENCE_CHANGED' } };
  });
}
