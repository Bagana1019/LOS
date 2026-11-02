// Модуль 6 (docs/05-collateral-documents.md §3, §6): модулийн тогтмолууд НЭГ газар. Бизнесийн босго (LTV, хуучралт, хүчинтэй хугацаа)
// энд БАЙХГҮЙ — setting / product-оос (CLAUDE.md §6.2). Энд зөвхөн төлөвийн жагсаалт ба DEMO хязгаарууд.

/** FR-10.4: зөвхөн "Шинэ" ба "Буцаасан" хүсэлтийн барьцааг засна. */
export const EDITABLE_STATUSES = ['DRAFT', 'RETURNED'] as const;
/** FR-14.6: үнэлгээ хадгалах, гадны үнэлгээ — идэвхтэй зээлд ч (дахин үнэлгээ), алхам өөрчлөхгүй. */
export const VALUATION_STATUSES = ['DRAFT', 'RETURNED', 'ACTIVE'] as const;
/** FR-6.9: ЭБ бүртгэл. */
export const REGISTRY_STATUSES = ['APPROVED', 'DISBURSING', 'ACTIVE'] as const;
/** FR-6.9: чөлөөлөлт. */
export const RELEASE_STATUS = 'CLOSED';
/** docs/05 §6 `DUPLICATE_PLEDGE`: хөрөнгийг "хүлээн авсан" (илгээгдсэн, баталгаажсан) хүсэлтүүд — өөр хүсэлтэд барьцаалахыг хориглоно. */
export const COMMITTED_STATUSES = ['SUBMITTED', 'IN_APPROVAL', 'APPROVED', 'DISBURSING', 'ACTIVE', 'MIGRATED'] as const;
/** Зөвхөн анхааруулга (`IN_OTHER_DRAFT`). */
export const DRAFT_STATUSES = ['DRAFT', 'RETURNED'] as const;
/** Мониторинг зөвхөн идэвхтэй зээлийн барьцаанд. */
export const MONITORED_STATUS = 'ACTIVE';

/** Барьцаалагч байж болох дүрүүд (FR-6.5). Батлан даагч өөрөө хөрөнгийн өмчлөгч бол "Барьцаалагч" дүрээр бас бүртгэнэ. */
export const OWNER_ROLES = ['PRIMARY', 'CO_BORROWER', 'PLEDGOR'] as const;

/** DEMO: нэг барьцаанд хавсаргах баримтын дээд тоо (эзний шийдвэр хүлээгдэж байна — docs/DECISIONS.md M6). */
export const MAX_DOCUMENTS_PER_COLLATERAL = 20;

/** 1-р алхамд барьцаалагч бүртгэх заавар — өмчлөгч хүсэлтийн оролцогч биш үед (AC: "Барьцаалагч бүртгэнэ үү"). */
export const REGISTER_PLEDGOR_HINT = 'Барьцаалагч бүртгэнэ үү (1-р алхам: Харилцагч -> Барьцаалагч)';

/** Төлөвийн дүрэм бүрийн 409 алдаа (тогтвортой `code` + монгол мессеж) — collateral-tx.service.ts `StatusRule`. */
export const RULE_EDITABLE = {
  statuses: EDITABLE_STATUSES as readonly string[],
  code: 'APPLICATION_NOT_EDITABLE',
  message: 'Хүсэлт "Шинэ" эсвэл "Буцаасан" төлөвт байх үед л барьцааг өөрчилнө',
};
export const RULE_VALUATION = {
  statuses: VALUATION_STATUSES as readonly string[],
  code: 'APPLICATION_NOT_EDITABLE',
  message: 'Үнэлгээг зөвхөн "Шинэ", "Буцаасан" эсвэл идэвхтэй зээлийн хүсэлтэд хийнэ',
};
export const RULE_REGISTRY = {
  statuses: REGISTRY_STATUSES as readonly string[],
  code: 'APPLICATION_NOT_APPROVED',
  message: 'Барьцааг ЭБ-д зөвхөн хүсэлт батлагдсаны дараа (Батлагдсан, Олголтод, Идэвхтэй) бүртгэнэ',
};
export const RULE_RELEASE = {
  statuses: [RELEASE_STATUS] as readonly string[],
  code: 'APPLICATION_NOT_CLOSED',
  message: 'Барьцааг зөвхөн зээл хаагдсан ("Хаагдсан") үед чөлөөлнө',
};
