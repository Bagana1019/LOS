import { Address, Employment, type BlacklistWarning, type CustomerContactView, type CustomerInput, type CustomerInputRaw, type CustomerSummary, type CustomerView, type Gender, type MaritalStatus } from '@los/contracts';
import { decryptedField, maskRegisterNo } from '@los/database';
import type { Customer, CustomerContact } from '.prisma/client-origination';

// NFR-5: регистр DB-д шифрлэгдсэн (AAD-гүй — өөр модуль `decryptedField(row.registerNoEncrypted)`-ээр тайлдаг; DECISIONS.md).
export const customerRegisterNo = (c: Pick<Customer, 'registerNoEncrypted'>): string => decryptedField(c.registerNoEncrypted);

const isoDate = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const parseJson = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, v: unknown): T | null => {
  if (v === null || v === undefined) return null;
  const r = schema.safeParse(v);
  return r.success ? r.data : null;
};

export function toContactView(c: CustomerContact): CustomerContactView {
  return {
    id: c.id, relation: c.relation as CustomerContactView['relation'], registerNo: c.registerNoEncrypted ? decryptedField(c.registerNoEncrypted) : null,
    lastName: c.lastName ?? undefined, firstName: c.firstName, phone: c.phone ?? '', employment: c.employment ?? undefined, homeAddress: c.homeAddress ?? undefined,
  };
}

export function toSummary(c: Customer, blacklisted: boolean): CustomerSummary {
  return {
    id: c.id, customerType: c.customerType as CustomerSummary['customerType'], registerNoMasked: maskRegisterNo(customerRegisterNo(c)),
    lastName: c.lastName, firstName: c.firstName, phone: c.phone, isPep: c.isPep, isRelatedParty: c.isRelatedParty, blacklisted, createdAt: c.createdAt.toISOString(),
  };
}

export function toView(c: Customer & { contacts: CustomerContact[] }, warnings: BlacklistWarning[]): CustomerView {
  const official = parseJson(Address, c.officialAddressJson);
  const residence = parseJson(Address, c.residenceAddressJson);
  return {
    id: c.id, customerType: c.customerType as CustomerView['customerType'], registerNo: customerRegisterNo(c), lastName: c.lastName, firstName: c.firstName,
    gender: c.gender as Gender | null, birthDate: isoDate(c.birthDate), phone: c.phone, email: c.email, photoFileId: c.photoFileId,
    familySize: c.familySize, activitySector: c.activitySector, maritalStatus: c.maritalStatus as MaritalStatus | null, segment: c.segment, education: c.education,
    isRelatedParty: c.isRelatedParty, isPep: c.isPep, amlRiskScore: c.amlRiskScore,
    officialAddress: official, residenceAddress: residence, residenceSameAsOfficial: !!official && JSON.stringify(official) === JSON.stringify(residence),
    employment: parseJson(Employment, c.employmentJson), xypFetchedAt: c.xypFetchedAt?.toISOString() ?? null, branchId: c.branchId,
    createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
    contacts: [...c.contacts].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)).map(toContactView),
    warnings,
  };
}

/** DB мөр → засварын үед дахин шалгах түүхий оролт (регистр нормчлогдсон). */
export function toRawInput(v: CustomerView): CustomerInputRaw {
  const n = <T>(x: T | null): T | undefined => x ?? undefined;
  return {
    customerType: v.customerType, registerNo: v.registerNo, lastName: n(v.lastName), firstName: v.firstName, gender: n(v.gender), birthDate: n(v.birthDate),
    phone: n(v.phone), email: n(v.email), photoFileId: n(v.photoFileId), familySize: n(v.familySize), activitySector: n(v.activitySector),
    maritalStatus: n(v.maritalStatus), segment: n(v.segment), education: n(v.education), isRelatedParty: v.isRelatedParty, isPep: v.isPep,
    officialAddress: n(v.officialAddress), residenceAddress: n(v.residenceAddress), residenceSameAsOfficial: v.residenceSameAsOfficial, employment: n(v.employment),
    contacts: v.contacts.map((c) => ({ relation: c.relation, registerNo: n(c.registerNo), lastName: c.lastName, firstName: c.firstName, phone: c.phone, employment: c.employment, homeAddress: c.homeAddress })),
  };
}

/** Аудитад: хувьсах бүх талбар (регистр/зураг `recordAudit`-д автоматаар [redacted]). */
export function auditSnapshot(i: CustomerInput): Record<string, unknown> {
  const { contacts, ...rest } = i;
  return { ...rest, contacts: contacts.map((c) => ({ relation: c.relation, firstName: c.firstName, lastName: c.lastName, phone: c.phone })) };
}
