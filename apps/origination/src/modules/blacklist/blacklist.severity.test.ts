import { beforeEach, describe, expect, it } from 'vitest';
import { BlacklistEntryChanged } from '@los/contracts';
import { adminCtx, entryInput, FixedClock, fakeCipher, SequentialIds } from './test-support';
import { BlacklistCreateBody, BlacklistListQuery, BlacklistPatchBody } from './blacklist.schemas';
import { BlacklistService } from './blacklist.service';
import { InMemoryBlacklistRepository } from './in-memory-blacklist.repository';
import { parseBlacklistCsv } from './csv';

// FR-13.1, BR-9: BLACK/GREY түвшин ба аудит (FR-13.5). DEMO шалгуур — docs/05-compliance-aml.md §11.
describe('blacklist severity (BLACK/GREY) and audit', () => {
  let repo: InMemoryBlacklistRepository;
  let service: BlacklistService;
  const input = (over: Record<string, unknown> = {}) => BlacklistCreateBody.parse(entryInput(over));

  beforeEach(() => {
    repo = new InMemoryBlacklistRepository();
    service = new BlacklistService(repo, fakeCipher, new FixedClock(), new SequentialIds());
  });

  it('defaults to BLACK and accepts GREY; unknown values are rejected', () => {
    expect(input().severity).toBe('BLACK');
    expect(input({ severity: 'GREY' }).severity).toBe('GREY');
    expect(BlacklistCreateBody.safeParse(entryInput({ severity: 'RED' })).success).toBe(false);
  });

  it('stores severity, returns it and emits it in the event (parses through the contract)', async () => {
    const entry = await service.create(adminCtx(), input({ severity: 'GREY' }));
    expect(entry.severity).toBe('GREY');
    expect(BlacklistEntryChanged.parse(repo.events[0]).severity).toBe('GREY');
  });

  it('PATCH can escalate GREY → BLACK and emits a new event + UPDATE audit', async () => {
    const created = await service.create(adminCtx(), input({ severity: 'GREY' }));
    const updated = await service.update(adminCtx(), created.id, BlacklistPatchBody.parse({ severity: 'BLACK' }));
    expect(updated.severity).toBe('BLACK');
    expect(repo.events).toHaveLength(2);
    expect(repo.audits.map((a) => a.action)).toEqual(['CREATE', 'UPDATE']);
    expect(repo.audits[1]).toMatchObject({ before: { severity: 'GREY' }, after: { severity: 'BLACK' } });
  });

  it('filters the list by severity', async () => {
    await service.create(adminCtx(), input({ severity: 'GREY' }));
    await service.create(adminCtx(), input({ registerNo: 'УБ99999999', severity: 'BLACK' }));
    const grey = await service.list(adminCtx(), BlacklistListQuery.parse({ severity: 'GREY' }));
    expect(grey.items.map((i) => i.severity)).toEqual(['GREY']);
    expect((await service.list(adminCtx(), BlacklistListQuery.parse({}))).total).toBe(2);
  });

  it('writes a PII-free audit row for create / deactivate / reactivate', async () => {
    const created = await service.create(adminCtx(), input());
    await service.deactivate(adminCtx(), created.id);
    await service.create(adminCtx(), input());
    expect(repo.audits.map((a) => a.action)).toEqual(['CREATE', 'DEACTIVATE', 'REACTIVATE']);
    const text = JSON.stringify(repo.audits);
    expect(text).not.toContain('УБ12345678');
    expect(text).not.toContain('Бат Болд');
    expect(repo.audits.every((a) => a.actorId === 'user-1' && a.correlationId === 'corr-1')).toBe(true);
  });

  it('CSV accepts an optional severity column', () => {
    const rows = parseBlacklistCsv('registerNo,customerType,name,reasonCode,severity\nУБ12345678,INDIVIDUAL,Бат,FRAUD_CASE,GREY\n');
    expect(rows[0]).toMatchObject({ data: { severity: 'GREY' } });
  });
});
