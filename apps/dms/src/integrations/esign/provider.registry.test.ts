import { describe, expect, it } from 'vitest';
import { MockMonpassProvider } from '../monpass/monpass.mock';
import { MockTridumProvider } from '../tridum/tridum.mock';
import { ESignProviderError } from './esign-provider.port';
import { ProviderRegistry } from './provider.registry';

const options = { clock: () => new Date(), approveAfterMs: 0, webhookSecret: 'registry-test-secret-0123456789' };

describe('ProviderRegistry', () => {
  const tridum = new MockTridumProvider(options);
  const monpass = new MockMonpassProvider(options);

  it('get(code) тохирох provider-ийг буцаана', () => {
    const registry = new ProviderRegistry([tridum, monpass]);
    expect(registry.get('TRIDUM')).toBe(tridum);
    expect(registry.get('MONPASS')).toBe(monpass);
  });

  it('бүртгэлгүй provider → NOT_CONFIGURED', () => {
    const registry = new ProviderRegistry([tridum]);
    expect(() => registry.get('MONPASS')).toThrowError(expect.objectContaining({ name: 'ESignProviderError', code: 'NOT_CONFIGURED', retryable: false }));
    expect(() => registry.get('MONPASS')).toThrow(ESignProviderError);
  });

  it('list() бүртгэсэн дарааллаар буцаана; буцаасан массивыг өөрчилсөн ч бүртгэл эвдрэхгүй', () => {
    const registry = new ProviderRegistry([monpass, tridum]);
    expect(registry.list()).toEqual([monpass, tridum]);
    (registry.list() as unknown[]).length = 0;
    expect(registry.list()).toHaveLength(2);
    expect(new ProviderRegistry([]).list()).toEqual([]);
  });

  it('ижил code-той provider хоёр удаа бүртгэвэл эхлэхэд алдаа', () => {
    expect(() => new ProviderRegistry([tridum, new MockTridumProvider(options)])).toThrow(/duplicate e-sign provider registered: TRIDUM/);
  });
});
