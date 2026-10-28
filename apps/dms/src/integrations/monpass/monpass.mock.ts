// FR-11.4 Monpass mock — нийтлэг MockRemoteSigner дээр суурилна (fixture-ийн хүснэгт mock-remote-signer.ts-д).
import { MockRemoteSigner, type MockProviderOptions } from '../esign/mock-remote-signer';

export class MockMonpassProvider extends MockRemoteSigner {
  constructor(options: MockProviderOptions) {
    super({ ...options, code: 'MONPASS', displayName: 'Monpass', refPrefix: 'MPS-MOCK', deepLinkScheme: 'mock-monpass' });
  }
}
