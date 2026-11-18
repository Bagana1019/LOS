import { z } from 'zod';

/**
 * FR-1.2 (M2): gateway (`iam` schema)-ийн унших-зөвхөн байгууллагын лавлах. Хүсэлтийн жагсаалт нь салбар / ЗЭЗ-ийг зөвхөн id-аар
 * хадгалдаг (cross-schema FK хориотой, CLAUDE.md §3.2.3), тиймээс web id → харуулах нэр рүү хөрвүүлнэ.
 * Зөвхөн харуулах нэр: username, email, phone, дүр, идэвхтэй эсэх БАЙХГҮЙ. Идэвхгүй болсон салбар/ЗЭЗ-ийн нэр хуучин хүсэлтэд хэрэгтэй тул орно.
 */
export const OrgDirectory = z.object({
  branches: z.record(z.string(), z.string()),
  users: z.record(z.string(), z.string()),
}).strict();
export type OrgDirectory = z.infer<typeof OrgDirectory>;
