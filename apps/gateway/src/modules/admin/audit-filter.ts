import { AUDIT_ACTOR_LIMIT, type AuditActorOption } from '@los/contracts';

/** F9-24 · Объект/үйлдлийн шүүлт (хэсэгчилсэн, том/жижиг үсэг үл ялгах, `%` `_` `\` escape-тэй): origination-ы аудит жагсаалттай нэг helper (@los/database). */
export { containsInsensitive } from '@los/database';

export interface ActorRow { id: string; username: string; fullName: string }

/**
 * F9-24 · "Хэн" шүүлтийн хайлт: нэвтрэх нэр эсвэл овог нэрээр (хэсэгчилсэн, том/жижиг үсэг үл ялгах).
 * Хайлтыг DB-ийн collation-д бус энд (JS) хийнэ: ILIKE-ийн кирилл том/жижиг үсгийн хөрвүүлэлт нь кластерийн locale-оос хамаарна.
 * Хэрэглэгчийн тоо байгууллагад цөөн тул санах ойд шүүхэд хямд. Дуудагчийн ганц `orgId`-ийн мөрүүдийг л өгнө.
 */
export function matchActors(users: readonly ActorRow[], q: string | undefined, limit = AUDIT_ACTOR_LIMIT): AuditActorOption[] {
  const needle = (q ?? '').trim().toLowerCase();
  return users
    .filter((u) => needle === '' || u.username.toLowerCase().includes(needle) || u.fullName.toLowerCase().includes(needle))
    .map(({ id, username, fullName }) => ({ id, username, fullName })) // зөвхөн гурван талбар (нууц мэдээлэл дамжихгүй)
    .sort((a, b) => a.fullName.localeCompare(b.fullName, 'mn') || a.username.localeCompare(b.username))
    .slice(0, limit);
}
