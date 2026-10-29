// SigningService.sweep() ба SigningSweeperService (interval): хугацаа дууссаныг хаах, provider аль хэдийн SIGNED бол finalize, гацсан FINALIZING.
import { DomainEvent } from '@los/contracts';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ESignProviderError } from '../../integrations/esign/esign-provider.port';
import { SigningFinalizationError } from './errors';
import type { PdfStamper } from './ports/pdf-stamper.port';
import { SigningSweeperService } from './signing-sweeper.service';
import type { SweepResult } from './signing.service';
import {
  captureLogs, createHarness, CTX, getSamplePdf, SIGNER_NAME, type CapturedLogs, type Harness,
} from './signing.test-harness';

let logs: CapturedLogs;
beforeAll(async () => {
  await getSamplePdf();
});
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const ZERO: SweepResult = { scanned: 0, signed: 0, expired: 0, declined: 0, failed: 0, retried: 0, errors: 0 };
const eventsOf = (h: Harness, type: string) => h.events().filter((event) => event.type === type);

describe('sweep(): хугацаа дууссан хүсэлт', () => {
  it('юу ч хугацаа дуусаагүй бол юу ч хийхгүй (event, audit-гүй)', async () => {
    const h = await createHarness();
    await h.create();
    h.clock.advanceHours(71);

    expect(await h.service.sweep()).toEqual(ZERO);
    expect(h.store.events).toHaveLength(1);
  });

  it('хугацаа дууссан PENDING → EXPIRED: failureReason, FAILED аудит (SYSTEM), анхны correlationId-тай ContractSigningFailed(EXPIRED)', async () => {
    const h = await createHarness();
    const { record } = await h.create();
    h.clock.advanceHours(72);
    h.clock.advanceSeconds(1);

    const result = await h.service.sweep();

    expect(result).toEqual({ ...ZERO, scanned: 1, expired: 1 });
    expect(await h.record(record.id)).toMatchObject({ status: 'EXPIRED', failureReason: 'EXPIRED' });
    const failed = eventsOf(h, 'ContractSigningFailed');
    expect(failed).toEqual([expect.objectContaining({ reason: 'EXPIRED', signingRequestId: record.id, correlationId: CTX.correlationId, actorId: null, occurredAt: h.clock.now().toISOString() })]);
    expect(DomainEvent.parse(failed[0])).toBeTruthy();
    expect((await h.store.listAudit(record.id)).at(-1)).toMatchObject({ type: 'FAILED', actor: 'SYSTEM', detail: { reason: 'EXPIRED' } });
  });

  it('давтан sweep нэмэлт event гаргахгүй; терминал хүсэлтэд хүрэхгүй', async () => {
    const h = await createHarness();
    const expired = await h.create();
    const cancelled = await h.create({ contractId: 'contract-2', applicationId: 'app-2' });
    await h.service.cancel(cancelled.record.id, CTX);
    h.clock.advanceHours(73);

    await h.service.sweep();
    const again = await h.service.sweep();

    expect(again).toEqual(ZERO);
    expect(eventsOf(h, 'ContractSigningFailed').map((e) => [e.signingRequestId, e.type === 'ContractSigningFailed' ? e.reason : null])).toEqual([
      [cancelled.record.id, 'CANCELLED'],
      [expired.record.id, 'EXPIRED'],
    ]);
  });

  it('IN_PROGRESS: provider хүлээсээр байвал session-ийг цуцалж EXPIRED болгоно', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token);
    const { providerRef } = await h.record(record.id);
    h.clock.advanceHours(73);
    vi.spyOn(h.tridum, 'getSession').mockResolvedValue({ state: 'PENDING' });
    const cancel = vi.spyOn(h.tridum, 'cancelSession');

    const result = await h.service.sweep();

    expect(result).toEqual({ ...ZERO, scanned: 1, expired: 1 });
    expect(await h.record(record.id)).toMatchObject({ status: 'EXPIRED', challengeCode: null, deepLink: null });
    expect(cancel).toHaveBeenCalledWith(providerRef);
  });

  it('IN_PROGRESS: provider аль хэдийн SIGNED бол дуусгахгүй, finalize хийнэ (гарын үсэг алдагдахгүй) — EXPIRED event гарахгүй', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token);
    await h.approve(record.id);
    h.clock.advanceHours(73); // линк дууссан, гэхдээ зээлдэгч хугацаандаа баталсан

    const result = await h.service.sweep();

    expect(result).toEqual({ ...ZERO, scanned: 1, signed: 1 });
    expect(await h.record(record.id)).toMatchObject({ status: 'SIGNED', failureReason: null });
    expect(eventsOf(h, 'ContractSigned')).toEqual([expect.objectContaining({ signingRequestId: record.id, correlationId: CTX.correlationId })]);
    expect(eventsOf(h, 'ContractSigningFailed')).toHaveLength(0);
    expect(h.storage.keys()).toHaveLength(3);
  });

  it('IN_PROGRESS: provider татгалзсан бол DECLINED, алдаатай бол FAILED(PROVIDER_ERROR), session дууссан бол EXPIRED (дахин оролдох PENDING байхгүй)', async () => {
    const h = await createHarness();
    const declined = await h.create({ contractId: 'c-1', applicationId: 'a-1' });
    const errored = await h.create({ contractId: 'c-2', applicationId: 'a-2' });
    const silent = await h.create({ contractId: 'c-3', applicationId: 'a-3' });
    await h.beginSigning(declined.token, 'TRIDUM');
    await h.beginSigning(errored.token, 'MONPASS');
    await h.beginSigning(silent.token, 'TRIDUM');
    h.tridum.declineNow((await h.record(declined.record.id)).providerRef as string);
    vi.spyOn(h.monpass, 'getSession').mockResolvedValue({ state: 'FAILED', code: 'MOCK_PROVIDER_ERROR', message: 'simulated' });
    h.clock.advanceHours(73);

    const result = await h.service.sweep();

    expect(result).toEqual({ ...ZERO, scanned: 3, declined: 1, failed: 1, expired: 1 });
    expect((await h.record(declined.record.id)).status).toBe('DECLINED');
    expect(await h.record(errored.record.id)).toMatchObject({ status: 'FAILED', failureReason: 'PROVIDER_ERROR', failureDetail: 'MOCK_PROVIDER_ERROR' });
    expect((await h.record(silent.record.id)).status).toBe('EXPIRED');
    expect(eventsOf(h, 'ContractSigningFailed').map((e) => (e.type === 'ContractSigningFailed' ? e.reason : null)).sort()).toEqual(['DECLINED', 'EXPIRED', 'PROVIDER_ERROR']);
  });

  it('provider түр боломжгүй бол алдаа тоолж, хүсэлтийг хэвээр үлдээнэ (гарын үсэг байж болзошгүй тул хаахгүй); provider сэргэхэд дараагийн sweep дуусгана', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token);
    await h.approve(record.id);
    h.clock.advanceHours(73);
    vi.spyOn(h.tridum, 'getSession').mockRejectedValueOnce(new ESignProviderError('UNAVAILABLE', 'down', true));

    expect(await h.service.sweep()).toEqual({ ...ZERO, scanned: 1, errors: 1 });
    expect((await h.record(record.id)).status).toBe('IN_PROGRESS');
    expect(logs.lines.some((line) => line.includes('esign.sweep.record_failed') && line.includes('SigningProviderUnavailableError'))).toBe(true);

    expect(await h.service.sweep()).toEqual({ ...ZERO, scanned: 1, signed: 1 });
  });

  it('provider байнга боломжгүй (тохиргоо хасагдсан) бол линк дууссан хүсэлт үүрд гацахгүй — EXPIRED', async () => {
    const h = await createHarness();
    const { record, token } = await h.create();
    await h.beginSigning(token);
    h.clock.advanceHours(73);
    vi.spyOn(h.registry, 'get').mockImplementation(() => {
      throw new ESignProviderError('NOT_CONFIGURED', 'removed');
    });

    expect(await h.service.sweep()).toEqual({ ...ZERO, scanned: 1, expired: 1 });
    expect((await h.record(record.id)).status).toBe('EXPIRED');
  });

  it('нэг бичлэгийн алдаа бусдыг зогсоохгүй', async () => {
    const h = await createHarness();
    const broken = await h.create({ contractId: 'c-1', applicationId: 'a-1' });
    const fine = await h.create({ contractId: 'c-2', applicationId: 'a-2' });
    h.clock.advanceHours(73);
    const original = h.store.transition.bind(h.store);
    vi.spyOn(h.store, 'transition').mockImplementation(async (id, from, patch, effects) => {
      if (id === broken.record.id) throw new Error(`db hiccup ${SIGNER_NAME}`);
      return original(id, from, patch, effects);
    });

    expect(await h.service.sweep()).toEqual({ ...ZERO, scanned: 2, errors: 1, expired: 1 });
    expect((await h.record(fine.record.id)).status).toBe('EXPIRED');
    expect((await h.record(broken.record.id)).status).toBe('PENDING');
    expect(logs.lines.join('\n')).not.toContain(SIGNER_NAME);
  });

  it('нэг sweep-д 100 хүртэл бичлэг авч, үлдсэнийг дараагийн sweep дуусгана', async () => {
    const h = await createHarness();
    for (let i = 0; i < 105; i++) await h.create({ contractId: `contract-${i}`, applicationId: `app-${i}` });
    h.clock.advanceHours(73);

    expect(await h.service.sweep()).toEqual({ ...ZERO, scanned: 100, expired: 100 });
    expect(await h.service.sweep()).toEqual({ ...ZERO, scanned: 5, expired: 5 });
    expect(await h.service.sweep()).toEqual(ZERO);
  });
});

describe('sweep(): гацсан FINALIZING', () => {
  /** Finalize-ийн явцад процесс унасныг дуурайна: FINALIZING төлөвт үлдсэн */
  async function stuckFinalizing(h: Harness) {
    const created = await h.create();
    await h.beginSigning(created.token);
    await h.approve(created.record.id);
    await h.store.transition(created.record.id, ['IN_PROGRESS'], { status: 'FINALIZING' });
    return created;
  }

  it('босго (ESIGN_FINALIZING_STALE_SEC=300) хүрээгүй FINALIZING-д хүрэхгүй', async () => {
    const h = await createHarness();
    const { record } = await stuckFinalizing(h);
    h.clock.advanceSeconds(299);

    expect(await h.service.sweep()).toEqual(ZERO);
    expect((await h.record(record.id)).status).toBe('FINALIZING');
  });

  it('босго хэтэрсэн FINALIZING-ийг IN_PROGRESS руу буцаагаад дахин finalize хийнэ → SIGNED, яг нэг ContractSigned', async () => {
    const h = await createHarness();
    const { record } = await stuckFinalizing(h);
    h.clock.advanceSeconds(301);

    const result = await h.service.sweep();

    expect(result).toEqual({ ...ZERO, scanned: 1, retried: 1, signed: 1 });
    expect((await h.record(record.id)).status).toBe('SIGNED');
    expect(eventsOf(h, 'ContractSigned')).toHaveLength(1);
    expect(h.storage.keys()).toHaveLength(3);
  });

  it('дахин оролдлого дахин унавал IN_PROGRESS хэвээр (алдаа тоологдоно), линк дууссан бол FAILED', async () => {
    let broken = true;
    const h = await createHarness({
      wrapStamper: (stamper): PdfStamper => ({
        stamp: (input) => (broken ? Promise.reject(new Error('stamper down')) : stamper.stamp(input)),
      }),
    });
    const { record } = await stuckFinalizing(h);
    h.clock.advanceSeconds(301);

    expect(await h.service.sweep()).toEqual({ ...ZERO, scanned: 1, retried: 1, errors: 1 });
    expect((await h.record(record.id)).status).toBe('IN_PROGRESS');
    expect(logs.lines.some((line) => line.includes('esign.sweep.record_failed') && line.includes(SigningFinalizationError.name))).toBe(true);

    broken = false;
    h.clock.advanceHours(73);
    // IN_PROGRESS + линк дууссан + provider SIGNED → finalize амжилттай
    expect(await h.service.sweep()).toEqual({ ...ZERO, scanned: 1, signed: 1 });
  });

  it('линк дууссан хойно гацсан FINALIZING дахин унавал үүрд оролдохгүй: FAILED(INTEGRITY_ERROR)', async () => {
    const h = await createHarness({ wrapStamper: (): PdfStamper => ({ stamp: () => Promise.reject(new Error('stamper down')) }) });
    const { record } = await stuckFinalizing(h);
    h.clock.advanceHours(73);

    expect(await h.service.sweep()).toEqual({ ...ZERO, scanned: 1, retried: 1, failed: 1 });
    expect(await h.record(record.id)).toMatchObject({ status: 'FAILED', failureReason: 'INTEGRITY_ERROR', failureDetail: 'FINALIZE_RETRIES_EXHAUSTED' });
    expect(eventsOf(h, 'ContractSigningFailed')).toHaveLength(1);
  });
});

describe('SigningSweeperService', () => {
  async function setup(sweepIntervalSec = 60) {
    const h = await createHarness({ config: { sweepIntervalSec } });
    const sweeper = new SigningSweeperService(h.service, h.config);
    return { h, sweeper };
  }

  it('ESIGN_SWEEP_INTERVAL_SEC=0 бол цаг хэмжигч үүсгэхгүй', async () => {
    vi.useFakeTimers();
    const { h, sweeper } = await setup(0);
    const sweep = vi.spyOn(h.service, 'sweep');

    sweeper.onModuleInit();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(sweep).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(logs.lines.some((line) => line.includes('esign.sweeper.disabled'))).toBe(true);
  });

  it('интервал бүрт sweep дуудна; timer unref хийгдсэн (процессыг амьд байлгахгүй)', async () => {
    vi.useFakeTimers();
    const { h, sweeper } = await setup(60);
    const sweep = vi.spyOn(h.service, 'sweep').mockResolvedValue(ZERO);

    sweeper.onModuleInit();
    expect((Reflect.get(sweeper, 'timer') as NodeJS.Timeout).hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sweep).toHaveBeenCalledTimes(3);

    await sweeper.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sweep).toHaveBeenCalledTimes(3);
  });

  it('жинхэнэ sweep-ийг тик бүрт ажиллуулж хугацаа дууссан хүсэлтийг хаана; лог-д ЗӨВХӨН тоо', async () => {
    vi.useFakeTimers();
    const { h, sweeper } = await setup(60);
    const { record } = await h.create();
    h.clock.advanceHours(73);

    sweeper.onModuleInit();
    await vi.advanceTimersByTimeAsync(60_000);
    await sweeper.onModuleDestroy();

    expect((await h.record(record.id)).status).toBe('EXPIRED');
    const line = logs.lines.find((l) => l.includes('"event":"esign.sweep"'));
    expect(JSON.parse(line as string)).toEqual({ event: 'esign.sweep', ...ZERO, scanned: 1, expired: 1 });
    expect(line).not.toContain(record.id);
  });

  it('хийх зүйлгүй тик лог дүүргэхгүй', async () => {
    const { sweeper } = await setup();
    await sweeper.tick();
    expect(logs.lines.filter((l) => l.includes('esign.sweep'))).toEqual([]);
  });

  it('өмнөх тик дуусаагүй бол шинэ sweep эхлүүлэхгүй (давхцахгүй), дуусмагц дахин ажиллана', async () => {
    const { h, sweeper } = await setup();
    let release!: () => void;
    const sweep = vi.spyOn(h.service, 'sweep').mockImplementation(() => new Promise<SweepResult>((resolve) => (release = () => resolve(ZERO))));

    const first = sweeper.tick();
    const second = sweeper.tick();
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    release();
    await first;

    const third = sweeper.tick();
    expect(sweep).toHaveBeenCalledTimes(2);
    release();
    await third;
  });

  it('sweep унавал тик reject хийхгүй, алдааны нэрийг л лог-д бичиж, дараагийн тик үргэлжилнэ', async () => {
    const { h, sweeper } = await setup();
    const sweep = vi.spyOn(h.service, 'sweep').mockRejectedValueOnce(new Error(`db down for ${SIGNER_NAME}`)).mockResolvedValue(ZERO);

    await expect(sweeper.tick()).resolves.toBeUndefined();
    await sweeper.tick();

    expect(sweep).toHaveBeenCalledTimes(2);
    expect(logs.lines.some((l) => l.includes('esign.sweep.failed') && l.includes('"errorName":"Error"'))).toBe(true);
    expect(logs.lines.join('\n')).not.toContain(SIGNER_NAME);
  });

  it('onModuleDestroy нь ажиллаж буй тикийг дуустал хүлээнэ', async () => {
    const { h, sweeper } = await setup();
    let release!: () => void;
    vi.spyOn(h.service, 'sweep').mockImplementation(() => new Promise<SweepResult>((resolve) => (release = () => resolve(ZERO))));
    const tick = sweeper.tick();
    let destroyed = false;

    const destroying = sweeper.onModuleDestroy().then(() => {
      destroyed = true;
    });
    await Promise.resolve();
    expect(destroyed).toBe(false);
    release();
    await Promise.all([tick, destroying]);
    expect(destroyed).toBe(true);
  });

  it('interval-ыг init хийгээгүй үед onModuleDestroy аюулгүй', async () => {
    const { sweeper } = await setup();
    await expect(sweeper.onModuleDestroy()).resolves.toBeUndefined();
  });
});
