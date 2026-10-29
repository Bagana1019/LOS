import { beforeEach, describe, expect, it, vi } from 'vitest';

// Харьцуулалт crypto.timingSafeEqual-аар (тэнцүү урттай буфер) явдгийг шалгана.
const spy = vi.hoisted(() => ({ calls: [] as Array<[number, number]> }));
vi.mock('crypto', async (orig) => {
  const actual = await orig<typeof import('crypto')>();
  return {
    ...actual,
    default: actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      spy.calls.push([a.byteLength, b.byteLength]);
      return actual.timingSafeEqual(a, b);
    },
  };
});

import { loadPosConfig } from '../config/pos.config';
import { MockSmsGateway } from '../integrations/sms/mock-sms.gateway';
import { createInMemoryPersistence } from '../persistence/memory/in-memory';
import { FixedOtpGenerator } from '../integrations/otp/fixed-otp.generator';
import { FakeClock } from '../testing/fake-clock';
import { makeLeaseRecord, makeMerchantRecord } from '../testing/records';
import { SequentialIdGenerator } from '../testing/sequential-id';
import { OtpService } from './otp.service';

describe('OtpService uses crypto.timingSafeEqual on equal-length buffers', () => {
  beforeEach(() => { spy.calls.length = 0; });
  it('compares 32-byte digests for right and wrong codes alike', async () => {
    const p = createInMemoryPersistence();
    const merchant = makeMerchantRecord();
    await p.merchants.createMerchant(merchant, []);
    const lease = makeLeaseRecord({ merchantId: merchant.id });
    const svc = new OtpService(p.otps, p.merchants, new MockSmsGateway(), new FixedOtpGenerator(), new FakeClock(), new SequentialIdGenerator(), loadPosConfig({ NODE_ENV: 'test' }));
    await svc.issue(lease, 'CONSENT', { userId: 'u', roles: [], orgId: 'org-test', branchId: null, merchantId: null, storeId: null, correlationId: 'c' });
    await svc.verify(lease, 'CONSENT', '000000').catch(() => undefined);
    await svc.verify(lease, 'CONSENT', '123456');
    expect(spy.calls).toEqual([[32, 32], [32, 32]]);
  });
});
