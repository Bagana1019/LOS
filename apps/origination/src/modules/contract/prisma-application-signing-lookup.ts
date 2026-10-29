import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { ApplicationStatus } from '@los/contracts';
import { decryptedField, isEncryptedField } from '@los/database';
import { PrismaService } from '../../prisma.service';
import type { ApplicationSigningLookup, SigningApplication } from './application-signing-lookup';

/** `customer` баганы AAD (packages/database encryptedField жишээ). Регистр нь `register_no_encrypted`-д. */
export const REGISTER_AAD = 'customer.register_no';
export const PHONE_AAD = 'customer.phone';

/**
 * Шифрлэгдсэн утгыг тайлна. AAD-тай тайлж чадахгүй бол AAD-гүй оролдоно (customer модуль AAD-г тавьсан эсэхээс үл хамаарах);
 * шифрлэгдээгүй утсыг (docs/03 `customer.phone` plain) хэвээр нь буцаана. Утгыг/алдааны мессежийг логлохгүй.
 */
function readPii(value: string, aad: string): string | null {
  if (!isEncryptedField(value)) return value;
  for (const candidate of [aad, undefined]) {
    try { return decryptedField(value, candidate); } catch { /* дараагийн хувилбар */ }
  }
  return null;
}

/** Origination-ийн `loan_application` + үндсэн зээлдэгчийн (`is_primary`) `customer` мөрийг уншина. */
@Injectable()
export class PrismaApplicationSigningLookup implements ApplicationSigningLookup {
  private readonly logger = new Logger(PrismaApplicationSigningLookup.name);

  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  async getForSigning(orgId: string, applicationId: string): Promise<SigningApplication | null> {
    const app = await this.db.loanApplication.findFirst({
      where: { id: applicationId, orgId },
      select: {
        id: true, orgId: true, officerId: true, branchId: true, status: true, contractNo: true,
        borrowers: { where: { isPrimary: true }, take: 1, select: { customer: { select: { id: true, lastName: true, firstName: true, phone: true, registerNoEncrypted: true } } } },
      },
    });
    if (!app) return null;
    const status = z.enum(ApplicationStatus).safeParse(app.status);
    if (!status.success) {
      this.logger.error({ event: 'esign.lookup.unknown_status', applicationId, status: app.status });
      return null;
    }

    const customer = app.borrowers[0]?.customer;
    let primaryBorrower: SigningApplication['primaryBorrower'] = null;
    if (customer) {
      const registerNo = readPii(customer.registerNoEncrypted, REGISTER_AAD);
      const phone = customer.phone ? readPii(customer.phone, PHONE_AAD) : '';
      if (registerNo === null || phone === null) {
        // Тайлж чадахгүй = түлхүүр/өгөгдөл эвдэрсэн. PII логлохгүй, "зээлдэгч бүртгэлгүй" гэж үзнэ (service 409 өгнө)
        this.logger.error({ event: 'esign.lookup.pii_unreadable', applicationId, customerId: customer.id });
      } else {
        primaryBorrower = { customerId: customer.id, fullName: [customer.lastName, customer.firstName].filter(Boolean).join(' '), registerNo, phone };
      }
    }
    return { orgId: app.orgId, applicationId: app.id, officerId: app.officerId, branchId: app.branchId, status: status.data, contractNo: app.contractNo, primaryBorrower };
  }
}
