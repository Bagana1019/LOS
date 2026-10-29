import { SEED, blindIndex, encryptedField } from '@los/database';
import type { PrismaService } from '../../prisma.service';
import { PHONE_AAD, REGISTER_AAD } from './prisma-application-signing-lookup';

// DB-тэй тестүүдийн нийтлэг fixture (production-д ашиглагдахгүй). Seed-ийн org/салбар/ЗЭЗ-ийг ашиглана.

export const REGISTER_NO = 'УА12345678';
export const PHONE = '99112233';

/** contract нь loan_application-д FK-тэй тул хүсэлтийг эхэлж үүсгэнэ (cascade-ээр хамт устна) */
export async function seedContract(db: PrismaService, input: { applicationId: string; orgId?: string; contractNo?: string; status?: string; officerId?: string | null; branchId?: string; [k: string]: unknown }): Promise<void> {
  const { applicationId, orgId = SEED.org.id, contractNo = `CN-${applicationId}`, status = 'APPROVED', officerId = SEED.users.officerA.id, branchId = SEED.branches.head.id, ...rest } = input;
  await db.loanApplication.create({ data: { id: applicationId, appNo: `A-${applicationId}`, orgId, branchId, officerId, status, contractNo } });
  await db.contract.create({ data: { orgId, applicationId, contractNo, ...rest } });
}

/** Үндсэн зээлдэгч (регистрийг шифрлэж, phone-ыг plain) + хүсэлтэд холбоно */
export async function seedBorrower(db: PrismaService, applicationId: string, o: { registerNoEncrypted?: string; phone?: string | null; isPrimary?: boolean; orgId?: string } = {}): Promise<string> {
  const orgId = o.orgId ?? SEED.org.id;
  const registerNo = `УА${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`;
  const customer = await db.customer.create({
    data: {
      orgId, registerNoHash: blindIndex(registerNo), registerNoEncrypted: o.registerNoEncrypted ?? encryptedField(registerNo, REGISTER_AAD),
      customerType: 'INDIVIDUAL', lastName: 'Бат-Эрдэнэ', firstName: 'Болд', phone: o.phone === undefined ? PHONE : o.phone,
    },
  });
  await db.loanApplicationBorrower.create({ data: { orgId, applicationId, customerId: customer.id, role: 'BORROWER', isPrimary: o.isPrimary ?? true } });
  return customer.id;
}

export { PHONE_AAD, REGISTER_AAD };
