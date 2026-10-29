import type { EncumbranceSourceResult } from '@los/contracts';
import { mockEncumbranceSources } from './encumbrance.fixture';
import type { EncumbranceAssetType, EncumbranceRegistry } from './encumbrance.registry';

/** DEMO: deterministic mock (дүрэм нь `encumbrance.fixture.ts`-д). Хөрөнгийн төрлөөс үл хамааран дугаарын хэлбэрээр шийднэ. */
export class MockEncumbranceRegistry implements EncumbranceRegistry {
  async check(_assetType: EncumbranceAssetType, identifier: string): Promise<EncumbranceSourceResult[]> {
    return mockEncumbranceSources(identifier);
  }
}
