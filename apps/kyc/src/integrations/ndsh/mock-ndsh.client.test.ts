import { describe, expect, it } from 'vitest';
import { IntegrationNotImplementedError } from '../errors';
import { MockNdshClient } from './mock-ndsh.client';
import { createNdshClient } from './ndsh.module';
import { NdshUnavailableError } from './ndsh.client';
import { RealNdshClient } from './real-ndsh.client';

describe('MockNdshClient (DEMO)', () => {
  const c = new MockNdshClient();
  it('is deterministic and returns at most 24 consecutive months ending 2026-10, one employer', async () => {
    const rows = await c.getSalaries('УБ90010112');
    expect(rows).toEqual(await new MockNdshClient().getSalaries('УБ90010112'));
    expect(rows.length).toBeGreaterThan(17);
    expect(rows.length).toBeLessThanOrEqual(24);
    expect(rows.at(-1)).toMatchObject({ year: 2026, month: 10 });
    expect(new Set(rows.map((r) => r.employer)).size).toBe(1);
    for (const r of rows) {
      expect(r.salary).toBeGreaterThan(800_000);
      expect(r.contributionPaid).toBeGreaterThan(0);
      expect(r.month).toBeGreaterThanOrEqual(1);
      expect(r.month).toBeLessThanOrEqual(12);
    }
    const ords = rows.map((r) => r.year * 12 + r.month);
    expect(ords.every((o, i) => i === 0 || o === ords[i - 1]! + 1)).toBe(true);
  });
  it('fixture registers: …00000000 has no salary, …99999999 is unavailable', async () => {
    expect(await c.getSalaries('УБ00000000')).toEqual([]);
    await expect(c.getSalaries('УБ99999999')).rejects.toBeInstanceOf(NdshUnavailableError);
  });
  it('INTEGRATION_MODE picks mock/real; real fails closed', async () => {
    expect(createNdshClient({})).toBeInstanceOf(MockNdshClient);
    const real = createNdshClient({ INTEGRATION_MODE: 'real' });
    expect(real).toBeInstanceOf(RealNdshClient);
    await expect(real.getSalaries('УБ90010112')).rejects.toBeInstanceOf(IntegrationNotImplementedError);
  });
});
