import { Module } from '@nestjs/common';
import { resolveIntegrationMode } from '../integration-mode';
import { INQUIRY_PROVIDER, type InquiryProvider } from './inquiry.provider';
import { MockInquiryProvider } from './mock-inquiry.provider';
import { RealInquiryProvider } from './real-inquiry.provider';
import { assertSainScoreProductionConfig } from './sainscore/sainscore.config';

/** CLAUDE.md §3.2.7: INTEGRATION_MODE-оор mock / real. Production + real: SainScore-ийн тохиргоо дутуу / http бол bootstrap-д унана. */
export function createInquiryProvider(env: Record<string, string | undefined> = process.env): InquiryProvider {
  if (resolveIntegrationMode(env) !== 'real') return new MockInquiryProvider();
  assertSainScoreProductionConfig(env);
  return new RealInquiryProvider({ env });
}

@Module({ providers: [{ provide: INQUIRY_PROVIDER, useFactory: () => createInquiryProvider() }], exports: [INQUIRY_PROVIDER] })
export class InquiryIntegrationModule {}
