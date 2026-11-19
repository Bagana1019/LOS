// M9 — sweepers run their tick on ONE pod at a time (Postgres advisory lock). Two PrismaService instances = two pods.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDatabase } from '@los/config/vitest/test-db.mjs';
import { SystemClock } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import type { OrgSettings } from '../../shared/org-settings';
import { DraftArchiveService } from '../application/draft-archive.service';
import type { MakerCheckerService } from '../maker-checker/maker-checker.service';
import { ExpirySweeper } from '../maker-checker/expiry.sweeper';
import type { ApprovalService } from './approval.service';
import { ApprovalSlaSweeper } from './approval.sla-sweeper';

const slow = <T>(value: T, ms = 300) => new Promise<T>((r) => setTimeout(() => r(value), ms));

describe.skipIf(!hasTestDatabase())('sweepers across pods (M9)', () => {
  const pods = [new PrismaService(), new PrismaService()] as const;
  beforeAll(async () => { await Promise.all(pods.map((p) => p.$connect())); });
  afterAll(async () => { await Promise.all(pods.map((p) => p.$disconnect())); });

  /** Each sweeper kind: build one instance per pod around a shared call counter. */
  const kinds = {
    'approval SLA': (db: PrismaService, calls: { n: number }) =>
      new ApprovalSlaSweeper({ sweepSla: () => { calls.n++; return slow(3); } } as unknown as ApprovalService, db),
    'maker-checker expiry': (db: PrismaService, calls: { n: number }) =>
      new ExpirySweeper({ expireOverdue: () => { calls.n++; return slow(2); } } as unknown as MakerCheckerService, db),
    'draft archive': (db: PrismaService, calls: { n: number }) => {
      const svc = new DraftArchiveService(db, {} as OrgSettings, new SystemClock());
      svc.sweepAll = () => { calls.n++; return slow(4); };
      return svc;
    },
  };

  for (const [name, make] of Object.entries(kinds)) {
    it(`${name}: concurrent ticks on two pods → the work runs exactly once`, async () => {
      const calls = { n: 0 };
      const [a, b] = pods.map((db) => make(db, calls));
      const results = await Promise.all([a!.tick(), b!.tick()]);
      expect(calls.n).toBe(1);
      expect(results.filter((r) => r > 0)).toHaveLength(1); // the skipping pod reports 0
    });

    it(`${name}: sequential ticks alternate between pods (lock released after each tick)`, async () => {
      const calls = { n: 0 };
      const [a, b] = pods.map((db) => make(db, calls));
      await a!.tick();
      await b!.tick();
      await a!.tick();
      expect(calls.n).toBe(3);
    });
  }

  it('a failing tick is logged, returns 0 and frees the lock for the next pod', async () => {
    let n = 0;
    const failing = new ApprovalSlaSweeper({ sweepSla: async () => { n++; throw new Error('db down'); } } as unknown as ApprovalService, pods[0]);
    const healthy = new ApprovalSlaSweeper({ sweepSla: async () => { n++; return 5; } } as unknown as ApprovalService, pods[1]);
    expect(await failing.tick()).toBe(0);
    expect(await healthy.tick()).toBe(5);
    expect(n).toBe(2);
  });
});
