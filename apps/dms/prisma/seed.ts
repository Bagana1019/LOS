// Модуль 0 seed (docs/04): checklist-ууд (FR-9.2, FR-6.7) ба хадгалах хугацаа (BSA-BR-8). Гэрээний загвар (docx) нь M11-д. Idempotent.
import { PrismaClient } from '.prisma/client-dms';
import { SEED } from '@los/database';

const prisma = new PrismaClient();
const orgId = SEED.org.id;

const applicationDocs = [
  { key: 'id_card', name: 'Иргэний үнэмлэхний хуулбар', relatedEntity: 'BORROWER' },
  { key: 'salary_statement', name: 'Цалингийн тодорхойлолт', relatedEntity: 'BORROWER' },
  { key: 'business_license', name: 'Бизнесийн гэрчилгээ', relatedEntity: 'BORROWER' },
  { key: 'application_form', name: 'Зээлийн хүсэлтийн маягт', relatedEntity: 'APPLICATION' },
];
// FR-6.7: хөрөнгийн төрлөөр заавал баримт
const collateralDocs: Record<string, { key: string; name: string }[]> = {
  APARTMENT: [{ key: 'ownership_certificate', name: 'Өмчлөх эрхийн гэрчилгээ' }, { key: 'cadastral_plan', name: 'Кадастрын зураг' }, { key: 'registry_extract', name: 'ЭБ-ийн лавлагаа' }],
  VEHICLE: [{ key: 'vehicle_certificate', name: 'Тээврийн хэрэгслийн гэрчилгээ' }, { key: 'traffic_registry_extract', name: 'ТЭЗ-ийн лавлагаа' }, { key: 'insurance', name: 'Даатгал' }],
  LIVESTOCK: [{ key: 'head_count_extract', name: 'Тоо толгойн лавлагаа' }],
  INVENTORY: [{ key: 'stocktake_act', name: 'Тооллогын акт' }],
};
const retention = [
  { entityType: 'BSA_STATEMENT', retentionYears: 3, autoDelete: true }, // BSA-BR-8
  { entityType: 'APPLICATION_DOCUMENT', retentionYears: 5, autoDelete: false },
  { entityType: 'CONTRACT', retentionYears: 5, autoDelete: false },
];

async function main() {
  let n = 0;
  for (const [i, d] of applicationDocs.entries()) {
    const exists = await prisma.documentChecklist.findFirst({ where: { orgId, productId: null, key: d.key } });
    if (!exists) { await prisma.documentChecklist.create({ data: { orgId, productId: null, key: d.key, name: d.name, relatedEntity: d.relatedEntity, isRequired: true, sortOrder: i } }); n++; }
  }
  for (const [assetType, docs] of Object.entries(collateralDocs)) {
    for (const [i, d] of docs.entries()) {
      const key = `${assetType.toLowerCase()}:${d.key}`;
      const exists = await prisma.documentChecklist.findFirst({ where: { orgId, productId: null, key } });
      if (!exists) { await prisma.documentChecklist.create({ data: { orgId, productId: null, key, name: d.name, relatedEntity: 'COLLATERAL', assetType, isRequired: true, sortOrder: i } }); n++; }
    }
  }
  for (const r of retention) {
    await prisma.retentionPolicy.upsert({ where: { orgId_entityType: { orgId, entityType: r.entityType } }, create: { orgId, ...r }, update: {} });
  }
  console.log(`dms seed: ${n} new checklist rows, ${retention.length} retention policies`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
