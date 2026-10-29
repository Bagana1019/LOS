// Зөвхөн тестэд: тогтмол цаг/id, хуурамч cipher (бодит encryptedField M00 хүртэл TODO), толгойн жишээ.
import type { RequestContext } from './blacklist.context';
import type { BlacklistRepository } from './blacklist.repository';
import type { Clock, IdGenerator, PiiCipher } from './blacklist.tokens';


/** Бодит шифр шиг: ciphertext нь plain регистрийг шууд агуулахгүй. */
export const fakeCipher: PiiCipher = {
  encrypt: (plain) => `fake:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (cipher) => Buffer.from(cipher.replace(/^fake:/, ''), 'base64').toString('utf8'),
};

export class FixedClock implements Clock {
  constructor(private current = new Date('2026-10-28T09:00:00.000Z')) {}
  now() { return new Date(this.current); }
  advance(ms: number) { this.current = new Date(this.current.getTime() + ms); }
}

export class SequentialIds implements IdGenerator {
  private n = 0;
  uuid() { return `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`; }
}

export const adminCtx = (over: Partial<RequestContext> = {}): RequestContext => ({
  userId: 'user-1', roles: ['ADMIN'], branchId: 'branch-1', correlationId: 'corr-1', orgId: 'org-1', ...over,
});

export const REGISTER = 'УБ12345678';
export const entryInput = (over: Record<string, unknown> = {}) => ({
  registerNo: REGISTER, customerType: 'INDIVIDUAL', name: 'Бат Болд', listType: 'DELINQUENT', reasonCode: 'LATE_PAYMENT', reasonText: 'Delinquent over 90 days', ...over,
});

/**
 * Зэрэг ирсэн `parties` хүсэлт БҮГД мөрөө уншиж дуустал findById-г хүлээлгэнэ: ингэснээр бичилтүүд аль хэдийн уншсан
 * (хуучирч болзошгүй) мөр дээр уралдана — гүйцэтгэлийн дарааллаас үл хамаарах тодорхой нөхцөл.
 */
export function gateReads(repo: BlacklistRepository, parties: number): BlacklistRepository {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return {
    list: (...a) => repo.list(...a),
    findByKey: (...a) => repo.findByKey(...a),
    saveWithEvent: (...a) => repo.saveWithEvent(...a),
    findById: async (...a) => {
      const row = await repo.findById(...a);
      if (++arrived >= parties) open();
      await gate;
      return row;
    },
  };
}
