import type { ApplicationStatus } from '@los/contracts';
// Цахим гарын үсэгт хэрэгтэй хүсэлт/зээлдэгчийн мэдээллийг авах port. Үндсэн adapter нь `PrismaApplicationSigningLookup`
// (loan_application + үндсэн зээлдэгч); тестэд `InMemoryApplicationSigningLookup`.

export interface SigningBorrower {
  customerId: string;
  fullName: string;
  /** PII — dms руу л дамжина, лог/алдаа/хариунд бүү гаргах */
  registerNo: string;
  /** PII — dms руу болон SMS notifier руу л дамжина */
  phone: string;
}

export interface SigningApplication {
  orgId: string;
  applicationId: string;
  /** ЗЭЗ; null → "Систем" (docs/03 loan_application.officer_id) */
  officerId: string | null;
  branchId: string;
  status: ApplicationStatus;
  /** Батлагдсаны дараа үүснэ */
  contractNo: string | null;
  primaryBorrower: SigningBorrower | null;
}

export interface ApplicationSigningLookup {
  /** Өөр байгууллагын эсвэл байхгүй хүсэлт бол null (орг хоорондын мэдээлэл задрахгүй) */
  getForSigning(orgId: string, applicationId: string): Promise<SigningApplication | null>;
}
export const APPLICATION_SIGNING_LOOKUP = Symbol('APPLICATION_SIGNING_LOOKUP');

/** Тест, local dev-д зориулсан санах ойн adapter. */
export class InMemoryApplicationSigningLookup implements ApplicationSigningLookup {
  private readonly items = new Map<string, SigningApplication>();

  set(application: SigningApplication): this {
    this.items.set(application.applicationId, structuredClone(application));
    return this;
  }

  async getForSigning(orgId: string, applicationId: string): Promise<SigningApplication | null> {
    const found = this.items.get(applicationId);
    return found && found.orgId === orgId ? structuredClone(found) : null;
  }
}
