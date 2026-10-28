import { UN_SC_FIXTURE } from './un-sc.fixture';
import type { UnScClient, UnSanctionsSnapshot } from './un-sc.client';

/** Deterministic: дуудалт бүрт fixture-ийн хуулбарыг буцаана (дуудагч өөрчилсөн ч fixture өөрчлөгдөхгүй). */
export class MockUnScClient implements UnScClient {
  async fetchSnapshot(): Promise<UnSanctionsSnapshot> {
    return structuredClone(UN_SC_FIXTURE);
  }
}
