import { Injectable } from '@nestjs/common';
import { DEFAULT_AML_POLICY, type AmlPolicy } from '@los/contracts';
import type { AmlPolicyProvider } from './aml.ports';

/** TODO: origination.settings-ийн SettingsChanged projection (CLAUDE.md §3.2.8) — одоогоор бүх org-д анхдагч бодлого. */
@Injectable()
export class StaticAmlPolicyProvider implements AmlPolicyProvider {
  async getPolicy(_orgId: string): Promise<AmlPolicy> {
    return DEFAULT_AML_POLICY;
  }
}
