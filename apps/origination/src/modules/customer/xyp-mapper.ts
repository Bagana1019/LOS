import type { CreateCustomerRequest, CustomerInputRaw, XypCitizen } from '@los/contracts';

/** ХУР-ын хариуг маягтын талбар болгоно (FR-2.2). Хоосон (null) утгыг орхино. */
export function citizenPrefill(c: XypCitizen): Partial<CustomerInputRaw> {
  const p: Partial<CustomerInputRaw> = { customerType: c.customerType, registerNo: c.registerNo, firstName: c.firstName };
  if (c.lastName) p.lastName = c.lastName;
  if (c.gender) p.gender = c.gender;
  if (c.birthDate) p.birthDate = c.birthDate;
  if (c.maritalStatus) p.maritalStatus = c.maritalStatus;
  if (c.familySize) p.familySize = c.familySize;
  if (c.activitySector) p.activitySector = c.activitySector;
  if (c.address) p.officialAddress = c.address;
  return p;
}

/** ХУР-аас ирсэн утга ЭРХТЭЙ — ЗЭЗ-ийн гараар бичсэн нэр, төрсөн огноог дарна (бүртгэлийн үнэн зөв байдал). */
const AUTHORITATIVE = ['customerType', 'registerNo', 'lastName', 'firstName', 'gender', 'birthDate', 'officialAddress'] as const;
/** ХУР хоцрох боломжтой (гэрлэлт, ам бүл) тул ЗЭЗ бөглөсөн бол түүнийг хадгалж, зөвхөн хоосныг нөхнө. */
const FILL_ONLY = ['maritalStatus', 'familySize', 'activitySector'] as const;

/** `source=XYP` үед: хүсэлтийн талбар + ХУР. Бусад талбар (утас, имэйл, зураг, хөдөлмөр, холбоо барих) ЗЭЗ-ээс. */
export function mergeXyp(req: Omit<CreateCustomerRequest, 'source'>, c: XypCitizen): Partial<CustomerInputRaw> {
  const prefill = citizenPrefill(c) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...req };
  for (const k of AUTHORITATIVE) if (prefill[k] !== undefined) out[k] = prefill[k];
  for (const k of FILL_ONLY) if (out[k] === undefined && prefill[k] !== undefined) out[k] = prefill[k];
  return out as Partial<CustomerInputRaw>;
}

/** `{officialAddress:{province}}` → `officialAddress.province` (хэдэн талбар автоматаар бөглөгдсөнийг тоолно). */
export function leafPaths(v: unknown, prefix = ''): string[] {
  if (v === null || v === undefined) return [];
  if (typeof v !== 'object' || Array.isArray(v)) return [prefix];
  return Object.entries(v).flatMap(([k, x]) => leafPaths(x, prefix ? `${prefix}.${k}` : k));
}
