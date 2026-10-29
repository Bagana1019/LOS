// Тайлангийн status/select баганы код → монгол шошго (docs/01 §4, §2.2). Excel нь эндээс шошгыг авна; UI нь column.options-оос.
export type Option = { value: string; label: string };
const opts = (m: Record<string, string>): Option[] => Object.entries(m).map(([value, label]) => ({ value, label }));

export const APPLICATION_STATUS = opts({
  DRAFT: 'Шинэ', SUBMITTED: 'Илгээсэн', IN_APPROVAL: 'Батлах явцад', APPROVED: 'Батлагдсан', RETURNED: 'Буцаасан',
  DISBURSING: 'Олгох', ACTIVE: 'Идэвхтэй', CLOSED: 'Хаасан', MIGRATED: 'Эхний үлдэгдэлтэй',
});
export const REPAYING_STATUS = APPLICATION_STATUS.filter((o) => o.value === 'ACTIVE' || o.value === 'MIGRATED');
export const AGING_BUCKET = opts({ CURRENT: 'Хэвийн', DPD_1_30: '1–30 хоног', DPD_31_60: '31–60 хоног', DPD_61_90: '61–90 хоног', DPD_90_PLUS: '90+ хоног' });
export const DISBURSEMENT_STATUS = opts({ APPROVED: 'Зөвшөөрсөн', SENT_TO_CORE: 'Core-д илгээсэн' });
export const PAYMENT_PROVIDER = opts({ QPAY: 'QPay', SOCIALPAY: 'SocialPay', BANK_TRANSFER: 'Банкны шилжүүлэг' });
export const REPAYMENT_TYPE = opts({ ANNUITY: 'Тэнцүү төлбөр', EQUAL_PRINCIPAL: 'Тэнцүү үндсэн төлбөр', QUARTERLY: 'Улирлын', BULLET: 'Төгсгөлд нь' });
export const COLLATERAL_STATUS = opts({ OK: 'Хэвийн', EXPIRING: '30 хоногт дуусна', EXPIRED: 'Хугацаа дууссан', RELEASED: 'Чөлөөлсөн' });
export const COLLATERAL_KIND = opts({ MOVABLE: 'Хөдлөх', IMMOVABLE: 'Үл хөдлөх' });
export const ASSET_TYPE = opts({ VEHICLE: 'Автомашин', APARTMENT: 'Орон сууц', HOUSE: 'Байшин', LAND: 'Газар', LIVESTOCK: 'Мал', INVENTORY: 'Бараа материал', EQUIPMENT: 'Тоног төхөөрөмж', OTHER: 'Бусад' });
export const ENCUMBRANCE_STATUS = opts({ CLEAR: 'Ачаалалгүй', ENCUMBERED: 'Ачаалалтай', DISPUTED: 'Маргаантай' });
export const STEP_KEY = opts({
  client: 'Харилцагч', inquiry: 'Лавлагаа', income: 'Орлого', loan: 'Зээлийн мэдээлэл', collateral: 'Барьцаа', installment: 'Эргэн төлөлтийн хуваарь',
  score: 'Тооцоолол', document: 'Баримт бичиг', decision: 'Шийдвэр', contract: 'Гэрээ', official_documents: 'Албан бичиг', disburse: 'Зээл олгох хүсэлт',
});
export const STEP_STATUS = opts({ PENDING: 'Бөглөөгүй', STALE: 'Хуучирсан' });
export const DEPOSIT_STATUS = opts({ ACTIVE: 'Идэвхтэй', DORMANT: 'Хөдөлгөөнгүй', CLOSED: 'Хаагдсан' });
export const CURRENCY = opts({ MNT: 'MNT (₮)', USD: 'USD ($)' });

export const labelOf = (options: Option[] | undefined, value: string): string => options?.find((o) => o.value === value)?.label ?? value;
