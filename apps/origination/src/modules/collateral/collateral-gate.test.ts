import { describe, expect, it } from 'vitest';
import { GateIssueCode } from '@los/contracts';
import { evaluateCollateralGate, externalValuationRequired, isValued, missingChecklistKeys, resolveChecklist, staleness } from './collateral-gate';
import { DAY, NOW, ago, collateral, encumbrance, gateInput, ownership, product } from './testing/gate-fixtures';

const codes = (r: ReturnType<typeof evaluateCollateralGate>) => r.gate.issues.map((i) => i.code);

describe('evaluateCollateralGate (G0)', () => {
  it('бүх шалгуур хангагдвал complete, issue байхгүй', () => {
    const r = evaluateCollateralGate(gateInput());
    expect(r.gate).toMatchObject({ complete: true, skipped: false, issues: [], evaluatedAt: NOW.toISOString() });
    expect(r.summary).toEqual({ count: 1, totalMarketValue: 30_000_000, totalCollateralValue: 21_000_000, loanAmount: 10_000_000, ltv: 10_000_000 / 21_000_000, ltvLimit: 0.7, ltvPass: true, requiresCollateral: true });
    expect(r.perCollateralIssues).toEqual({});
  });

  describe('LTV (FR-14.4, BR-3)', () => {
    it('AC: зээл 50,000,000 / барьцаа 30,000,000 × 0.7 = 21,000,000 → LTV_EXCEEDED, алхам бүрдэхгүй', () => {
      const r = evaluateCollateralGate(gateInput({ loanAmount: 50_000_000 }));
      expect(r.gate.complete).toBe(false);
      expect(codes(r)).toEqual(['LTV_EXCEEDED']);
      const issue = r.gate.issues[0]!;
      expect(issue.collateralId).toBeNull();
      expect(issue.message).toContain('238.1%');
      expect(issue.message).toContain('70%');
      expect(issue.details).toMatchObject({ limit: 0.7, loanAmount: 50_000_000, totalCollateralValue: 21_000_000 });
      expect(r.summary).toMatchObject({ ltvPass: false, ltvLimit: 0.7 });
      expect(r.summary.ltv).toBeCloseTo(2.380952, 5);
    });

    it('0 дүнтэй үнэлгээ (haircut 0 / дөрвөлжин 0.004 → 0.00) «үнэлэгдсэн» биш: NOT_VALUED, LTV чимээгүй алгасагдахгүй', () => {
      const r = evaluateCollateralGate(gateInput({ collaterals: [collateral({ marketValue: 0, collateralValue: 0 })] }));
      expect(r.gate.complete).toBe(false);
      expect(codes(r)).toContain('NOT_VALUED');
      expect(isValued(collateral({ marketValue: 30_000_000, collateralValue: 0 }))).toBe(false);
    });

    it('LTV яг дээд хязгаартай тэнцүү (14,700,000 / 21,000,000 = 70%) → хангана; 1₮ илүү → хэтэрнэ', () => {
      expect(evaluateCollateralGate(gateInput({ loanAmount: 14_700_000 })).gate.complete).toBe(true);
      const over = evaluateCollateralGate(gateInput({ loanAmount: 14_700_001 }));
      expect(codes(over)).toEqual(['LTV_EXCEEDED']);
    });

    it('дээд хязгаар: product.maxLtv өгсөн бол тэр, үгүй бол setting br3.ltv_max', () => {
      // 12,000,000 / 21,000,000 = 57.1%
      expect(evaluateCollateralGate(gateInput({ loanAmount: 12_000_000, product: product({ maxLtv: 0.5 }) })).summary).toMatchObject({ ltvLimit: 0.5, ltvPass: false });
      expect(evaluateCollateralGate(gateInput({ loanAmount: 12_000_000, product: product({ maxLtv: null }), settings: { staleDays: 30, ltvMax: 0.6 } })).summary).toMatchObject({ ltvLimit: 0.6, ltvPass: true });
      expect(evaluateCollateralGate(gateInput({ loanAmount: 12_000_000, product: product({ maxLtv: null }), settings: { staleDays: 30, ltvMax: 0.5 } })).summary).toMatchObject({ ltvLimit: 0.5, ltvPass: false });
    });

    it('Σ барьцааны үнэлгээ: олон барьцааны нийлбэрээр; үнэлэгдээгүй барьцаа тооцогдохгүй', () => {
      const r = evaluateCollateralGate(gateInput({
        loanAmount: 30_000_000,
        collaterals: [collateral({ id: 'a' }), collateral({ id: 'b', marketValue: 20_000_000, collateralValue: 14_000_000, valuationId: 'v2' }), collateral({ id: 'c', marketValue: null, collateralValue: null, valuationId: null, valuationSource: null, valuedAt: null })],
      }));
      expect(r.summary).toMatchObject({ count: 3, totalMarketValue: 50_000_000, totalCollateralValue: 35_000_000 });
      expect(r.summary.ltv).toBeCloseTo(30_000_000 / 35_000_000, 6);
      expect(r.summary.ltvPass).toBe(false); // 85.7% > 70%
      expect(codes(r)).toEqual(['NOT_VALUED', 'LTV_EXCEEDED']);
    });

    it('барьцааны үнэлгээ огт байхгүй → ltv=null, ltvPass=null, LTV_EXCEEDED нэмэгдэхгүй (NOT_VALUED аль хэдийн)', () => {
      const r = evaluateCollateralGate(gateInput({ collaterals: [collateral({ marketValue: null, collateralValue: null, valuationId: null, valuationSource: null, valuedAt: null })] }));
      expect(r.summary).toMatchObject({ ltv: null, ltvPass: null, totalCollateralValue: 0 });
      expect(codes(r)).toEqual(['NOT_VALUED']);
    });
  });

  describe('хүсэлтийн түвшний issue (PRODUCT_MISSING, NO_COLLATERAL, LOAN_AMOUNT_MISSING)', () => {
    it('бүтээгдэхүүн сонгоогүй → PRODUCT_MISSING (LTV дээд нь setting-ээс)', () => {
      const r = evaluateCollateralGate(gateInput({ product: null, collaterals: [], settings: { staleDays: 30, ltvMax: 0.65 } }));
      expect(codes(r)).toEqual(['PRODUCT_MISSING']);
      expect(r.gate).toMatchObject({ complete: false, skipped: false });
      expect(r.summary.ltvLimit).toBe(0.65);
    });

    it('барьцаа шаардах бүтээгдэхүүн, барьцаа алга → NO_COLLATERAL', () => {
      const r = evaluateCollateralGate(gateInput({ collaterals: [] }));
      expect(codes(r)).toEqual(['NO_COLLATERAL']);
      expect(r.gate).toMatchObject({ complete: false, skipped: false });
      expect(r.summary).toMatchObject({ count: 0, ltv: null, ltvPass: null, requiresCollateral: true });
    });

    it('FR-6.4: барьцаа шаардахгүй бүтээгдэхүүн, барьцаа алга → skipped + complete', () => {
      const r = evaluateCollateralGate(gateInput({ product: product({ requiresCollateral: false }), collaterals: [] }));
      expect(r.gate).toMatchObject({ complete: true, skipped: true, issues: [] });
      expect(r.summary.requiresCollateral).toBe(false);
    });

    it('барьцаа шаардахгүй ч барьцаа нэмсэн бол энгийнээр шалгана (skipped=false)', () => {
      const ok = evaluateCollateralGate(gateInput({ product: product({ requiresCollateral: false }) }));
      expect(ok.gate).toMatchObject({ complete: true, skipped: false });
      const bad = evaluateCollateralGate(gateInput({ product: product({ requiresCollateral: false }), collaterals: [collateral({ ownership: null })] }));
      expect(codes(bad)).toEqual(['OWNERSHIP_NOT_CHECKED']);
    });

    it.each([null, 0, -5, Number.NaN])('зээлийн дүн %s → LOAN_AMOUNT_MISSING, LTV тооцохгүй', (amount) => {
      const r = evaluateCollateralGate(gateInput({ loanAmount: amount }));
      expect(codes(r)).toEqual(['LOAN_AMOUNT_MISSING']);
      expect(r.summary).toMatchObject({ loanAmount: null, ltv: null, ltvPass: null });
    });

    it('барьцаа алга бол зээлийн дүнгүй ч LOAN_AMOUNT_MISSING гарахгүй', () => {
      expect(codes(evaluateCollateralGate(gateInput({ loanAmount: null, collaterals: [], product: product({ requiresCollateral: false }) })))).toEqual([]);
    });

    it('чөлөөлөгдсөн барьцааг тооцохгүй', () => {
      const r = evaluateCollateralGate(gateInput({ collaterals: [collateral({ id: 'released', releasedAt: new Date(NOW.getTime() - DAY), ownership: null })] }));
      expect(codes(r)).toEqual(['NO_COLLATERAL']);
      expect(r.summary.count).toBe(0);
    });
  });

  describe('өмчлөл (FR-6.5, FR-6.8)', () => {
    it('шалгаагүй → OWNERSHIP_NOT_CHECKED', () => {
      const r = evaluateCollateralGate(gateInput({ collaterals: [collateral({ ownership: null })] }));
      expect(codes(r)).toEqual(['OWNERSHIP_NOT_CHECKED']);
      expect(r.perCollateralIssues['col-1']).toHaveLength(1);
      expect(r.gate.issues[0]!.collateralId).toBe('col-1');
    });

    it('OWNER_MISMATCH, OWNER_NOT_ON_APPLICATION статус → тус тусын код; сүүлийнх нь "Барьцаалагч бүртгэнэ үү"', () => {
      expect(codes(evaluateCollateralGate(gateInput({ collaterals: [collateral({ ownership: ownership({ status: 'OWNER_MISMATCH', message: null }) })] })))).toEqual(['OWNER_MISMATCH']);
      const r = evaluateCollateralGate(gateInput({ collaterals: [collateral({ ownership: ownership({ status: 'OWNER_NOT_ON_APPLICATION', message: null }) })] }));
      expect(codes(r)).toEqual(['OWNER_NOT_ON_APPLICATION']);
      expect(r.gate.issues[0]!.message).toContain('Барьцаалагч бүртгэнэ үү');
    });

    it('шалгалтын мессежийг (ownership.message) issue-д дамжуулна', () => {
      const r = evaluateCollateralGate(gateInput({ collaterals: [collateral({ ownership: ownership({ status: 'OWNER_MISMATCH', message: 'Өөр өмчлөгч' }) })] }));
      expect(r.gate.issues[0]!.message).toBe('Өөр өмчлөгч');
    });

    it('хуучирсан лавлагаа: яг stale_days (30) хоног → хүчинтэй; 1мс илүү → OWNERSHIP_STALE', () => {
      const edge = evaluateCollateralGate(gateInput({ collaterals: [collateral({ ownership: ownership({ checkedAt: ago(30 * DAY) }) })] }));
      expect(edge.gate.complete).toBe(true);
      const stale = evaluateCollateralGate(gateInput({ collaterals: [collateral({ ownership: ownership({ checkedAt: ago(30 * DAY + 1) }) })] }));
      expect(codes(stale)).toEqual(['OWNERSHIP_STALE']);
      expect(stale.gate.issues[0]!.details).toMatchObject({ staleDays: 30, ageDays: 30 });
    });

    it('stale_days setting-ээс: 7 хоног болговол 8 хоногийн өмнөх лавлагаа хуучирна', () => {
      const input = gateInput({ settings: { staleDays: 7, ltvMax: 0.7 }, collaterals: [collateral({ ownership: ownership({ checkedAt: ago(8 * DAY) }) })] });
      expect(codes(evaluateCollateralGate(input))).toEqual(['OWNERSHIP_STALE']);
    });

    it('өмчлөгч хүсэлтийн оролцогч биш болсон (дүр алга) эсвэл зөвхөн батлан даагч бол хуучин VERIFIED ч хүчингүй', () => {
      for (const ownerRole of [null, 'GUARANTOR'] as const) {
        const r = evaluateCollateralGate(gateInput({ collaterals: [collateral({ ownerRole })] }));
        expect(codes(r)).toEqual(['OWNER_NOT_ON_APPLICATION']);
      }
      expect(codes(evaluateCollateralGate(gateInput({ collaterals: [collateral({ ownerCustomerId: null })] })))).toEqual(['OWNER_NOT_ON_APPLICATION']);
      for (const ownerRole of ['PRIMARY', 'CO_BORROWER', 'PLEDGOR'] as const) expect(evaluateCollateralGate(gateInput({ collaterals: [collateral({ ownerRole })] })).gate.complete).toBe(true);
    });

    it('хэлбэр буруу checkedAt = хуучирсан (fail closed)', () => {
      expect(codes(evaluateCollateralGate(gateInput({ collaterals: [collateral({ ownership: ownership({ checkedAt: 'not-a-date' }) })] })))).toEqual(['OWNERSHIP_STALE']);
    });
  });

  describe('ачаалал (FR-6.6, FR-6.8)', () => {
    it('шалгаагүй → ENCUMBRANCE_NOT_CHECKED', () => {
      expect(codes(evaluateCollateralGate(gateInput({ collaterals: [collateral({ encumbrance: null })] })))).toEqual(['ENCUMBRANCE_NOT_CHECKED']);
    });

    it('ENCUMBERED (барьцаалагчийн нэртэй) ба DISPUTED', () => {
      const enc = evaluateCollateralGate(gateInput({ collaterals: [collateral({ encumbrance: encumbrance({ status: 'ENCUMBERED', sources: [{ source: 'ZMS', status: 'ENCUMBERED', pledgee: 'Жишээ ББСБ', registeredAt: null, note: null }] }) })] }));
      expect(codes(enc)).toEqual(['ENCUMBERED']);
      expect(enc.gate.issues[0]!.details).toMatchObject({ pledgees: ['Жишээ ББСБ'] });
      expect(codes(evaluateCollateralGate(gateInput({ collaterals: [collateral({ encumbrance: encumbrance({ status: 'DISPUTED' }) })] })))).toEqual(['ENCUMBRANCE_DISPUTED']);
    });

    it('хуучралт: яг 30 хоног → хүчинтэй; 1мс илүү → ENCUMBRANCE_STALE (CLEAR л хуучирна)', () => {
      expect(evaluateCollateralGate(gateInput({ collaterals: [collateral({ encumbrance: encumbrance({ checkedAt: ago(30 * DAY) }) })] })).gate.complete).toBe(true);
      expect(codes(evaluateCollateralGate(gateInput({ collaterals: [collateral({ encumbrance: encumbrance({ checkedAt: ago(30 * DAY + 1) }) })] })))).toEqual(['ENCUMBRANCE_STALE']);
      // ENCUMBERED + хуучирсан → илүү чухал код нэг л удаа
      expect(codes(evaluateCollateralGate(gateInput({ collaterals: [collateral({ encumbrance: encumbrance({ status: 'ENCUMBERED', checkedAt: ago(90 * DAY) }) })] })))).toEqual(['ENCUMBERED']);
    });
  });

  describe('давхар барьцаа (FR-6.6)', () => {
    it('өөр идэвхтэй хүсэлтийн дугаартай DUPLICATE_PLEDGE', () => {
      const r = evaluateCollateralGate(gateInput({ duplicatePledges: { 'col-1': ['APP-00007', 'APP-00009'] } }));
      expect(codes(r)).toEqual(['DUPLICATE_PLEDGE']);
      expect(r.gate.issues[0]).toMatchObject({ collateralId: 'col-1', details: { applicationNos: ['APP-00007', 'APP-00009'] } });
      expect(r.gate.issues[0]!.message).toContain('APP-00007, APP-00009');
    });

    it('өөр барьцааны давхардал энэ барьцаанд нөлөөлөхгүй', () => {
      expect(evaluateCollateralGate(gateInput({ duplicatePledges: { other: ['APP-1'] } })).gate.complete).toBe(true);
    });
  });

  describe('баримтын checklist (FR-6.7)', () => {
    it('заавал баримт дутуу → CHECKLIST_INCOMPLETE (дутуу түлхүүр, монгол нэртэй)', () => {
      const r = evaluateCollateralGate(gateInput({ collaterals: [collateral({ documentKeys: ['vehicle_certificate'] })] }));
      expect(codes(r)).toEqual(['CHECKLIST_INCOMPLETE']);
      expect(r.gate.issues[0]!.details).toEqual({ missing: ['traffic_registry_extract', 'insurance'] });
      expect(r.gate.issues[0]!.message).toContain('ТЭЗ-ийн лавлагаа');
      expect(r.gate.issues[0]!.message).toContain('Даатгалын гэрээ');
    });

    it('давхар баримт, нэмэлт (other) баримт нь дутууг нөхөхгүй; бүгд байвал хангана', () => {
      expect(codes(evaluateCollateralGate(gateInput({ collaterals: [collateral({ documentKeys: ['other', 'other', 'vehicle_certificate'] })] })))).toEqual(['CHECKLIST_INCOMPLETE']);
      expect(evaluateCollateralGate(gateInput({ collaterals: [collateral({ documentKeys: ['insurance', 'insurance', 'vehicle_certificate', 'traffic_registry_extract', 'other'] })] })).gate.complete).toBe(true);
    });

    it('{key, required:false} түлхүүр заавал биш; хөрөнгийн төрөлд checklist байхгүй бол хоосон', () => {
      const p = product({ collateralChecklist: { VEHICLE: ['vehicle_certificate', { key: 'insurance', required: false }, { key: 'traffic_registry_extract', required: true }] } });
      const r = evaluateCollateralGate(gateInput({ product: p, collaterals: [collateral({ documentKeys: ['vehicle_certificate'] })] }));
      expect(r.gate.issues[0]!.details).toEqual({ missing: ['traffic_registry_extract'] });
      expect(evaluateCollateralGate(gateInput({ product: product({ collateralChecklist: { LAND: ['x'] } }), collaterals: [collateral({ documentKeys: [] })] })).gate.complete).toBe(true);
      expect(evaluateCollateralGate(gateInput({ product: product({ collateralChecklist: null }), collaterals: [collateral({ documentKeys: [] })] })).gate.complete).toBe(true);
    });

    it('resolveChecklist: давхардсан түлхүүрийг нэгтгэнэ (заавал давамгайлна); missingChecklistKeys', () => {
      expect(resolveChecklist({ VEHICLE: ['a', { key: 'a', required: false }, { key: 'b', required: false }, { key: 'b', required: true }, { key: 'c', required: false }] }, 'VEHICLE')).toEqual([
        { key: 'a', required: true }, { key: 'b', required: true }, { key: 'c', required: false },
      ]);
      expect(resolveChecklist(null, 'VEHICLE')).toEqual([]);
      expect(missingChecklistKeys([{ key: 'a', required: true }, { key: 'b', required: false }], [])).toEqual(['a']);
    });
  });

  describe('үнэлгээ (FR-14.2–14.3)', () => {
    const unvalued = { marketValue: null, collateralValue: null, valuationId: null, valuationSource: null, valuedAt: null } as const;

    it('үнэлгээ алга → NOT_VALUED; зөвхөн хэсэгчилсэн талбар байвал мөн NOT_VALUED', () => {
      expect(codes(evaluateCollateralGate(gateInput({ collaterals: [collateral(unvalued)] })))).toEqual(['NOT_VALUED']);
      expect(codes(evaluateCollateralGate(gateInput({ collaterals: [collateral({ valuationId: null })] })))).toEqual(['NOT_VALUED']);
      expect(codes(evaluateCollateralGate(gateInput({ collaterals: [collateral({ valuedAt: null })] })))).toEqual(['NOT_VALUED']);
      expect(isValued(collateral())).toBe(true);
      expect(isValued(collateral(unvalued))).toBe(false);
    });

    it('VALUATION_EXPIRED: яг valid_until → хүчинтэй; 1мс өнгөрвөл дууссан; valid_until=null бол хугацаагүй', () => {
      const at = new Date(NOW.getTime());
      expect(evaluateCollateralGate(gateInput({ collaterals: [collateral({ valuationValidUntil: at })] })).gate.complete).toBe(true);
      const expired = evaluateCollateralGate(gateInput({ collaterals: [collateral({ valuationValidUntil: new Date(NOW.getTime() - 1) })] }));
      expect(codes(expired)).toEqual(['VALUATION_EXPIRED']);
      expect(expired.gate.issues[0]!.message).toContain('2026-10-29');
      expect(evaluateCollateralGate(gateInput({ collaterals: [collateral({ valuationValidUntil: null })] })).gate.complete).toBe(true);
    });

    it('EXTERNAL_VALUATION_REQUIRED: valuation-ий тэмдэг эсвэл босго (≥); гадны лицензтэй үнэлгээгээр хангана', () => {
      const flagged = evaluateCollateralGate(gateInput({ collaterals: [collateral({ externalValuationRequired: true })] }));
      expect(codes(flagged)).toEqual(['EXTERNAL_VALUATION_REQUIRED']);
      // босго 100,000,000: яг тэнцүү → шаардана; 1₮ бага → шаардахгүй
      const big = (marketValue: number, source: 'INTERNAL' | 'EXTERNAL_LICENSED' = 'INTERNAL') => gateInput({ loanAmount: 10_000_000, collaterals: [collateral({ marketValue, collateralValue: marketValue * 0.7, valuationSource: source })] });
      expect(codes(evaluateCollateralGate(big(100_000_000)))).toEqual(['EXTERNAL_VALUATION_REQUIRED']);
      expect(evaluateCollateralGate(big(99_999_999)).gate.complete).toBe(true);
      expect(evaluateCollateralGate(big(100_000_000, 'EXTERNAL_LICENSED')).gate.complete).toBe(true);
      expect(evaluateCollateralGate(gateInput({ collaterals: [collateral({ externalValuationRequired: true, valuationSource: 'EXTERNAL_LICENSED' })] })).gate.complete).toBe(true);
      // босго тохируулаагүй бүтээгдэхүүн
      expect(evaluateCollateralGate({ ...big(500_000_000), product: product({ externalValuationThreshold: null }) }).gate.complete).toBe(true);
      expect(externalValuationRequired({ marketValue: 1, externalValuationRequired: false }, null)).toBe(false);
    });
  });

  describe('ерөнхий', () => {
    it('issue-ууд: хүсэлтийн түвшин → барьцаа бүр (баримт бүртгэлийн дарааллаар) → LTV; perCollateralIssues зөв бүлэглэнэ', () => {
      const r = evaluateCollateralGate(gateInput({
        loanAmount: 100_000_000,
        collaterals: [
          collateral({ id: 'a', ownership: null, encumbrance: null }),
          collateral({ id: 'b', documentKeys: [] }),
        ],
      }));
      expect(r.gate.issues.map((i) => `${i.collateralId}:${i.code}`)).toEqual(['a:OWNERSHIP_NOT_CHECKED', 'a:ENCUMBRANCE_NOT_CHECKED', 'b:CHECKLIST_INCOMPLETE', 'null:LTV_EXCEEDED']);
      expect(Object.keys(r.perCollateralIssues).sort()).toEqual(['a', 'b']);
      expect(r.perCollateralIssues['a']!.map((i) => i.code)).toEqual(['OWNERSHIP_NOT_CHECKED', 'ENCUMBRANCE_NOT_CHECKED']);
    });

    it('docs/05 §6-ийн БҮХ GateIssueCode дор хаяж нэг хувилбарт гарна', () => {
      const seen = new Set<string>();
      const run = (over: Parameters<typeof gateInput>[0]) => evaluateCollateralGate(gateInput(over)).gate.issues.forEach((i) => seen.add(i.code));
      run({ product: null });
      run({ collaterals: [] });
      run({ loanAmount: null });
      run({ loanAmount: 50_000_000 });
      run({ collaterals: [collateral({ ownership: null, encumbrance: null, documentKeys: [], marketValue: null, collateralValue: null, valuationId: null, valuationSource: null, valuedAt: null })] });
      run({ collaterals: [collateral({ ownership: ownership({ checkedAt: ago(99 * DAY) }), encumbrance: encumbrance({ checkedAt: ago(99 * DAY) }), valuationValidUntil: new Date(NOW.getTime() - 1), externalValuationRequired: true })] });
      run({ collaterals: [collateral({ ownership: ownership({ status: 'OWNER_MISMATCH' }), encumbrance: encumbrance({ status: 'ENCUMBERED' }) })] });
      run({ collaterals: [collateral({ ownership: ownership({ status: 'OWNER_NOT_ON_APPLICATION' }), encumbrance: encumbrance({ status: 'DISPUTED' }) })], duplicatePledges: { 'col-1': ['APP-1'] } });
      expect([...seen].sort()).toEqual([...GateIssueCode].sort());
    });

    it('staleness: ирээдүйн огноо хуучраагүй; хоногийн тоо доош бөөрөнхийлөгдөнө', () => {
      expect(staleness(new Date(NOW.getTime() + DAY).toISOString(), NOW, 30)).toEqual({ stale: false, ageDays: 0 });
      expect(staleness(ago(2.5 * DAY), NOW, 30)).toEqual({ stale: false, ageDays: 2 });
      expect(staleness('', NOW, 30)).toEqual({ stale: true, ageDays: null });
    });
  });
});
