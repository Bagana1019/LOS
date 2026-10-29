import { describe, expect, it } from 'vitest';
import { BorrowerCandidate, BorrowerView } from '@los/contracts';
import { blindIndex, encryptedField } from '@los/database';
import { Prisma } from '.prisma/client-origination';
import { sortBorrowers, toBorrowerView, toCandidate, toRow, type BorrowerWithCustomer } from './borrower.mapper';
import { customerDisplayName, customerRegisterNoMasked } from './customer-directory';

const customer = (o: Partial<BorrowerWithCustomer['customer']> = {}): BorrowerWithCustomer['customer'] => ({
  id: 'cust-1', orgId: 'org', branchId: null, registerNoHash: blindIndex('УБ90000012'), registerNoEncrypted: encryptedField('УБ90000012'), customerType: 'INDIVIDUAL',
  lastName: 'Болд', firstName: 'Бат', gender: null, birthDate: null, phone: '99112233', email: 'bat@example.mn', photoFileId: null, familySize: null, activitySector: null,
  maritalStatus: null, segment: null, education: null, isRelatedParty: false, isPep: true, amlRiskScore: null, officialAddressJson: null, residenceAddressJson: null,
  employmentJson: null, xypFetchedAt: null, createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date(), createdBy: null, updatedBy: null, ...o,
});
const borrower = (o: Partial<BorrowerWithCustomer> = {}): BorrowerWithCustomer => ({
  id: 'b1', orgId: 'org', applicationId: 'app-1', customerId: 'cust-1', role: 'CO_BORROWER', isPrimary: false, relationToPrimary: 'SPOUSE', liabilityShare: new Prisma.Decimal('0.4'),
  guaranteeType: null, guaranteeAmount: null, consentFileId: 'f1', consentSignedAt: new Date('2026-10-27T09:00:00Z'), incomeIncluded: true, note: null,
  createdAt: new Date('2026-10-02T00:00:00Z'), updatedAt: new Date(), createdBy: null, updatedBy: null, customer: customer(), ...o,
});

describe('customerDisplayName / customerRegisterNoMasked', () => {
  it('"Овог Нэр"; овог байхгүй (хуулийн этгээд) бол зөвхөн нэр; илүү зайг цэвэрлэнэ', () => {
    expect(customerDisplayName({ lastName: 'Болд', firstName: 'Бат' })).toBe('Болд Бат');
    expect(customerDisplayName({ lastName: null, firstName: 'Монгол ХХК' })).toBe('Монгол ХХК');
    expect(customerDisplayName({ lastName: ' ', firstName: ' Бат ' })).toBe('Бат');
  });
  it('регистрийг задалж нуугдмал хэлбэрээр: эхний 2, сүүлийн 2 тэмдэгт', () => {
    expect(customerRegisterNoMasked(customer())).toBe('УБ****0012');
    expect(customerRegisterNoMasked(customer({ registerNoEncrypted: encryptedField('1234567') }))).toBe('12*4567');
  });
});

describe('sortBorrowers', () => {
  it('үндсэн → хамтран → батлан даагч → барьцаалагч, дараа нь нэмсэн дарааллаар', () => {
    const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, '0')}T00:00:00Z`);
    const rows = [
      { id: 'a', role: 'PLEDGOR', createdAt: at(1) }, { id: 'b', role: 'CO_BORROWER', createdAt: at(5) }, { id: 'c', role: 'GUARANTOR', createdAt: at(2) },
      { id: 'd', role: 'PRIMARY', createdAt: at(9) }, { id: 'e', role: 'CO_BORROWER', createdAt: at(3) },
    ];
    expect(sortBorrowers(rows).map((r) => r.id)).toEqual(['d', 'e', 'b', 'c', 'a']);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e']); // эх массивыг өөрчлөхгүй
  });
  it('ижил цагтай бол id-аар тогтвортой', () => {
    const t = new Date('2026-10-01T00:00:00Z');
    expect(sortBorrowers([{ id: 'z', role: 'GUARANTOR', createdAt: t }, { id: 'y', role: 'GUARANTOR', createdAt: t }]).map((r) => r.id)).toEqual(['y', 'z']);
  });
});

describe('toBorrowerView / toRow / toCandidate', () => {
  it('Decimal → number, Date → ISO; DTO-д тохирно; бүтэн регистр байхгүй', () => {
    const view = toBorrowerView(borrower());
    expect(BorrowerView.parse(view)).toEqual(view);
    expect(view).toMatchObject({ liabilityShare: 0.4, guaranteeAmount: null, consentSignedAt: '2026-10-27T09:00:00.000Z', createdAt: '2026-10-02T00:00:00.000Z' });
    expect(view.customer).toMatchObject({ displayName: 'Болд Бат', registerNoMasked: 'УБ****0012', isPep: true });
    expect(JSON.stringify(view)).not.toContain('УБ90000012');
    expect(JSON.stringify(view)).not.toContain('registerNoHash');
  });
  it('мөнгөн дүн 2 оронтой Decimal', () => {
    const view = toBorrowerView(borrower({ role: 'GUARANTOR', liabilityShare: null, guaranteeType: 'LIMITED', guaranteeAmount: new Prisma.Decimal('5000000.50') }));
    expect(view).toMatchObject({ guaranteeAmount: 5_000_000.5, liabilityShare: null, guaranteeType: 'LIMITED' });
  });
  it('toRow: дүрмийн оролт', () => {
    expect(toRow(borrower())).toMatchObject({ id: 'b1', role: 'CO_BORROWER', liabilityShare: 0.4, consentSignedAt: new Date('2026-10-27T09:00:00Z'), customer: { displayName: 'Болд Бат', customerType: 'INDIVIDUAL', isPep: true, isRelatedParty: false } });
  });
  it('toCandidate: linkedRoles эрэмбэлэгдэнэ; DTO-д тохирно', () => {
    const c = toCandidate(customer(), ['PLEDGOR', 'PRIMARY']);
    expect(BorrowerCandidate.parse(c)).toEqual(c);
    expect(c).toEqual({ customerId: 'cust-1', displayName: 'Болд Бат', registerNoMasked: 'УБ****0012', customerType: 'INDIVIDUAL', phone: '99112233', linkedRoles: ['PRIMARY', 'PLEDGOR'] });
  });
});
