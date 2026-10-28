import type { PortalCustomerLookup, PortalProfile } from '@los/contracts';
import type { AnonymousContext, CallContext } from '../../common/request-context';

export const CUSTOMER_DIRECTORY = Symbol('CUSTOMER_DIRECTORY');

/**
 * Харилцагчийн лавлах (origination.customer). Нэвтрэхэд регистр + утас тохирч, зээлтэй (идэвхтэй/хаагдсан)
 * харилцагчийг л танина — тохирохгүй бол null (хэзээ ч «регистр олдсонгүй» гэж ялгаж хэлэхгүй).
 */
export interface CustomerDirectoryPort {
  lookupForLogin(input: { registerNo: string; phone: string }, ctx: AnonymousContext): Promise<PortalCustomerLookup | null>;
  getProfile(ctx: CallContext): Promise<PortalProfile>;
}
