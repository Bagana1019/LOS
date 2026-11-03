import { IntegrationNotImplementedError } from '../errors';
import type { ExternalInquirySource, InquiryProvider, ProviderResult } from './inquiry.provider';

/** Бодит ЗМС / FICO / ХУР холболт хараахан хийгдээгүй (docs/04 «Хүний оролцоо» №1) — fail closed, зохиомол хариу өгөхгүй. */
export class RealInquiryProvider implements InquiryProvider {
  async fetch(source: ExternalInquirySource, _registerNo: string): Promise<ProviderResult> {
    throw new IntegrationNotImplementedError(`inquiry:${source}`);
  }
}
