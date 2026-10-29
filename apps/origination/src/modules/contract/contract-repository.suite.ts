import { beforeAll, describe, expect, it as baseIt } from 'vitest';
import type { ContractRecord, ContractRepository } from './contract.repository';

export interface RepositoryHarness {
  repo: ContractRepository;
  /** Тестэд зориулж contract мөр оруулна (гэрээ үүсгэх модулийн ажлыг орлоно); applicationId давхцахгүй байх ёстой */
  seed(input: Partial<ContractRecord> & Pick<ContractRecord, 'applicationId'>): Promise<void>;
}

const LONG_AGO = new Date('2020-01-01T00:00:00.000Z');

/** Memory ба Prisma хоёр implementation-д ижил CAS дүрмийг баталгаажуулах нийтлэг тест */
export function describeContractRepository(name: string, makeHarness: () => RepositoryHarness, options: { available?: () => Promise<boolean> } = {}): void {
  describe(`ContractRepository: ${name}`, () => {
    const uid = () => `app-${crypto.randomUUID()}`;
    // Гадаад хамаарал (Postgres) байхгүй бол тестүүдийг алгасна
    let available = true;
    beforeAll(async () => {
      available = (await options.available?.()) ?? true;
    });
    const it = (title: string, fn: () => Promise<void>) => baseIt(title, async (ctx) => {
      if (!available) {
        ctx.skip();
        return;
      }
      await fn();
    });

    it('байхгүй хүсэлтэд null, байвал анхдагч утгуудтай мөр буцаана', async () => {
      const { repo, seed } = makeHarness();
      expect(await repo.getByApplicationId(uid())).toBeNull();
      const applicationId = uid();
      await seed({ applicationId, contractNo: 'B-1', generatedFileId: 'file-1' });
      expect(await repo.getByApplicationId(applicationId)).toMatchObject({
        applicationId, contractNo: 'B-1', generatedFileId: 'file-1', signChannel: 'PAPER', signingRequestId: null, signingStatus: null,
        signingFailureReason: null, signingSentAt: null, signedFileId: null, signedAt: null,
      });
    });

    it('patch-ийг хэрэглэж, updatedAt шинэчилнэ; undefined талбарыг хөндөхгүй, null цэвэрлэнэ', async () => {
      const { repo, seed } = makeHarness();
      const applicationId = uid();
      await seed({ applicationId, updatedAt: LONG_AGO, signingFailureReason: 'EXPIRED', signingStatus: 'EXPIRED', signingRequestId: 'sr-old' });
      const sentAt = new Date('2026-10-28T09:00:00.000Z');

      expect(await repo.updateSigning(applicationId, {
        signChannel: 'ESIGN', signingRequestId: 'sr-1', signingStatus: 'PENDING', signingFailureReason: null, signingSentAt: sentAt,
      })).toBe(true);

      const after = await repo.getByApplicationId(applicationId);
      expect(after).toMatchObject({ signChannel: 'ESIGN', signingRequestId: 'sr-1', signingStatus: 'PENDING', signingFailureReason: null, signingSentAt: sentAt });
      expect(after!.updatedAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());

      // undefined → өөрчлөхгүй
      expect(await repo.updateSigning(applicationId, { signingStatus: 'IN_PROGRESS' })).toBe(true);
      expect(await repo.getByApplicationId(applicationId)).toMatchObject({ signingRequestId: 'sr-1', signingSentAt: sentAt, signingStatus: 'IN_PROGRESS' });
    });

    it('мөр байхгүй бол false', async () => {
      const { repo } = makeHarness();
      expect(await repo.updateSigning(uid(), { signingStatus: 'PENDING' })).toBe(false);
    });

    it('guard.expectedRequestId таарахгүй бол өөрчлөхгүй (stale), таарвал хэрэглэнэ; request id-гүй мөрд таарахгүй', async () => {
      const { repo, seed } = makeHarness();
      const applicationId = uid();
      await seed({ applicationId, signingRequestId: 'sr-2', signingStatus: 'PENDING' });

      expect(await repo.updateSigning(applicationId, { signingStatus: 'DECLINED' }, { expectedRequestId: 'sr-1' })).toBe(false);
      expect((await repo.getByApplicationId(applicationId))!.signingStatus).toBe('PENDING');
      expect(await repo.updateSigning(applicationId, { signingStatus: 'DECLINED' }, { expectedRequestId: 'sr-2' })).toBe(true);
      expect((await repo.getByApplicationId(applicationId))!.signingStatus).toBe('DECLINED');

      const fresh = uid();
      await seed({ applicationId: fresh });
      expect(await repo.updateSigning(fresh, { signingStatus: 'PENDING' }, { expectedRequestId: 'sr-1' })).toBe(false);
      expect(await repo.updateSigning(fresh, { signingStatus: 'PENDING', signingRequestId: 'sr-1' })).toBe(true);
    });

    it('SIGNED мөрийг ХЭЗЭЭ Ч өөрчлөхгүй (downgrade хориотой), SIGNED болгох нь зөвхөн SIGNED биш мөрөөс', async () => {
      const { repo, seed } = makeHarness();
      const applicationId = uid();
      await seed({ applicationId, signingRequestId: 'sr-1', signingStatus: 'PENDING' });
      const signedAt = new Date('2026-10-28T09:05:00.000Z');

      expect(await repo.updateSigning(applicationId, { signingStatus: 'SIGNED', signedFileId: 'signed-1', signedAt, signChannel: 'ESIGN' }, { expectedRequestId: 'sr-1' })).toBe(true);
      expect(await repo.updateSigning(applicationId, { signingStatus: 'FAILED', signingFailureReason: 'PROVIDER_ERROR' }, { expectedRequestId: 'sr-1' })).toBe(false);
      expect(await repo.updateSigning(applicationId, { signingRequestId: 'sr-2', signingStatus: 'PENDING' })).toBe(false);
      expect(await repo.getByApplicationId(applicationId)).toMatchObject({ signingStatus: 'SIGNED', signedFileId: 'signed-1', signedAt, signChannel: 'ESIGN', signingRequestId: 'sr-1', signingFailureReason: null });
    });

    it('зэрэгцээ SIGNED ба FAILED бичилтийн дараа үргэлж SIGNED үлдэнэ (атомар)', async () => {
      const { repo, seed } = makeHarness();
      for (let i = 0; i < 25; i++) {
        const applicationId = uid();
        await seed({ applicationId, signingRequestId: 'sr-1', signingStatus: 'PENDING' });
        await Promise.all([
          repo.updateSigning(applicationId, { signingStatus: 'FAILED', signingFailureReason: 'PROVIDER_ERROR' }, { expectedRequestId: 'sr-1' }),
          repo.updateSigning(applicationId, { signingStatus: 'SIGNED', signedFileId: 'signed-1' }, { expectedRequestId: 'sr-1' }),
        ]);
        expect((await repo.getByApplicationId(applicationId))!.signingStatus).toBe('SIGNED');
      }
    });
  });
}
