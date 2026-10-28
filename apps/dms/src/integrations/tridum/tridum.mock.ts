// FR-11.4 Tridum mock — нийтлэг MockRemoteSigner дээр суурилна (fixture-ийн хүснэгт mock-remote-signer.ts-д).
import { MockRemoteSigner, type MockProviderOptions } from '../esign/mock-remote-signer';

export class MockTridumProvider extends MockRemoteSigner {
  constructor(options: MockProviderOptions) {
    super({ ...options, code: 'TRIDUM', displayName: 'Tridum', refPrefix: 'TRD-MOCK', deepLinkScheme: 'mock-tridum' });
  }
}
