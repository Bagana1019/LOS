// FR-11.4 Идэвхтэй provider-уудын бүртгэл. Жагсаалтыг integrations.module.ts INTEGRATION_MODE-оор бүрдүүлнэ.
import { Inject, Injectable } from '@nestjs/common';
import type { ESignProvider as ESignProviderCode } from '@los/contracts';
import { ESIGN_PROVIDERS, ESignProviderError, type ESignProviderPort } from './esign-provider.port';

@Injectable()
export class ProviderRegistry {
  private readonly byCode = new Map<ESignProviderCode, ESignProviderPort>();

  constructor(@Inject(ESIGN_PROVIDERS) providers: readonly ESignProviderPort[]) {
    for (const provider of providers) {
      if (this.byCode.has(provider.code)) throw new Error(`duplicate e-sign provider registered: ${provider.code}`);
      this.byCode.set(provider.code, provider);
    }
  }

  /** Бүртгэлгүй provider → `ESignProviderError('NOT_CONFIGURED')` */
  get(code: ESignProviderCode): ESignProviderPort {
    const provider = this.byCode.get(code);
    if (!provider) throw new ESignProviderError('NOT_CONFIGURED', `e-sign provider ${code} is not configured`);
    return provider;
  }

  list(): readonly ESignProviderPort[] {
    return [...this.byCode.values()];
  }
}
