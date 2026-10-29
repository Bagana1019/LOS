import { FATF_FIXTURE } from './fatf.fixture';
import type { FatfClient, FatfSnapshot } from './fatf.client';

/** Deterministic: дуудалт бүрт fixture-ийн хуулбарыг буцаана (дуудагч өөрчилсөн ч fixture өөрчлөгдөхгүй). */
export class MockFatfClient implements FatfClient {
  async fetchSnapshot(): Promise<FatfSnapshot> {
    return structuredClone(FATF_FIXTURE);
  }
}
