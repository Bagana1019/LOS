import { Module } from '@nestjs/common';
import { resolveIntegrationMode } from '../integration-mode';
import { INQUIRY_PROVIDER, type InquiryProvider } from './inquiry.provider';
import { MockInquiryProvider } from './mock-inquiry.provider';
import { RealInquiryProvider } from './real-inquiry.provider';

/** CLAUDE.md §3.2.7: INTEGRATION_MODE-оор mock / real. */
export function createInquiryProvider(env: Record<string, string | undefined> = process.env): InquiryProvider {
  return resolveIntegrationMode(env) === 'real' ? new RealInquiryProvider() : new MockInquiryProvider();
}

@Module({ providers: [{ provide: INQUIRY_PROVIDER, useFactory: () => createInquiryProvider() }], exports: [INQUIRY_PROVIDER] })
export class InquiryIntegrationModule {}
