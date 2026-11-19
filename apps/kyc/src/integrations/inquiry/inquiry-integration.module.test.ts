import { describe, expect, it } from 'vitest';
import { IntegrationNotConfiguredError } from '../errors';
import { createInquiryProvider } from './inquiry-integration.module';
import { MockInquiryProvider } from './mock-inquiry.provider';
import { RealInquiryProvider } from './real-inquiry.provider';

// Phase 5: production + real горимд SainScore-ийн тохиргоог bootstrap-д шалгана.
const FULL = { SAINSCORE_BASE_URL: 'https://zms.example.mn/api', SAINSCORE_USERNAME: 'lender', SAINSCORE_PASSWORD_HASH: 'hash-secret', SAINSCORE_PRODUCT_NO: '13611304' };
const PROD = { NODE_ENV: 'production', INTEGRATION_MODE: 'real' };

describe('createInquiryProvider', () => {
  it('анхдагч (production биш) → mock', () => {
    expect(createInquiryProvider({})).toBeInstanceOf(MockInquiryProvider);
  });
  it('production + explicit mock → mock (SainScore env шаардахгүй)', () => {
    expect(createInquiryProvider({ NODE_ENV: 'production', INTEGRATION_MODE: 'mock' })).toBeInstanceOf(MockInquiryProvider);
  });
  it('real + production биш + тохиргоо дутуу → апп унахгүй (дуудлага бүр fail-closed)', () => {
    expect(createInquiryProvider({ INTEGRATION_MODE: 'real' })).toBeInstanceOf(RealInquiryProvider);
  });
  it('production + real + бүрэн тохиргоо → RealInquiryProvider', () => {
    expect(createInquiryProvider({ ...PROD, ...FULL })).toBeInstanceOf(RealInquiryProvider);
  });
  it('production + real + дутуу тохиргоо → bootstrap-д унана (нэр л, утга биш)', () => {
    const env = { ...PROD, ...FULL, SAINSCORE_USERNAME: '' };
    expect(() => createInquiryProvider(env)).toThrow(IntegrationNotConfiguredError);
    expect(() => createInquiryProvider(env)).toThrow(/SAINSCORE_USERNAME/);
  });
  it('production + real + http base URL → bootstrap-д унана', () => {
    expect(() => createInquiryProvider({ ...PROD, ...FULL, SAINSCORE_BASE_URL: 'http://zms.example.mn' })).toThrow(/SAINSCORE_BASE_URL/);
  });
});
