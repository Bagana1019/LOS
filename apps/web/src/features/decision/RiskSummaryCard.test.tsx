import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DecisionRisk } from '@los/contracts';
import { t } from '../../lib/i18n';
import { RiskSummaryCard } from './RiskSummaryCard';

// F3-1: батлагч шийдвэрийн хуудаснаас ӨОХ/ӨТЧХ, LTV, Sosco, барьцаа, орлого, анхааруулгыг харна. Карт зөвхөн сервер хадгалсан утгыг харуулна (тооцоолол хийхгүй).
const risk = (o: Partial<DecisionRisk> = {}): DecisionRisk => ({
  method: 'A_SALARY', selection: 'AUTO', computedAt: '2026-11-20T03:00:00.000Z', stale: false,
  ratio: { kind: 'DTI', value: 0.4321, limit: 0.55, pass: true },
  ltv: { value: 0.0625, limit: 0.7, pass: true },
  sosco: { score: 712, grade: 'B' },
  collateral: { count: 2, totalValue: 80_000_000, required: true },
  income: { salaryMonthly: 2_500_000, businessNcfMonthly: 300_000, householdExpenseMonthly: 400_000 },
  flags: [], ...o,
});
const html = (r: DecisionRisk | null | undefined) => renderToStaticMarkup(<RiskSummaryCard risk={r} />);

describe('RiskSummaryCard (F3-1)', () => {
  it('хадгалагдсан үзүүлэлтүүд: арга (монгол шошго), ӨОХ %, LTV %, Sosco, барьцаа ₮, орлого ₮', () => {
    const out = html(risk());
    expect(out).toContain('data-testid="risk-card"');
    expect(out).toContain(t('decide.risk.title'));
    expect(out).toContain('A · Цалин');
    expect(out).not.toContain('A_SALARY'); // түүхий enum харагдахгүй
    expect(out).toContain(t('score.ratio.DTI'));
    expect(out).toContain('43.21%');
    expect(out).toContain(t('decide.risk.limitMax', { value: '55%' }));
    expect(out).toContain('6.25%'); // LTV
    expect(out).toContain('712');
    expect(out).toContain('B');
    expect(out).toContain('80,000,000₮');
    expect(out).toContain('2,500,000₮');
    expect(out).toContain('300,000₮');
    expect(out).toContain('400,000₮');
    expect(out).toContain(t('decide.risk.noFlags'));
  });

  it('B/C арга: ӨТЧХ шошго, харьцаа 2 оронтой, доод хязгаар', () => {
    const out = html(risk({ method: 'B_BUSINESS', selection: 'MANUAL', ratio: { kind: 'DSCR', value: 1.8, limit: 1.25, pass: true } }));
    expect(out).toContain('B · Бизнес');
    expect(out).toContain(t('decide.risk.selection.MANUAL'));
    expect(out).toContain(t('score.ratio.DSCR'));
    expect(out).toContain('1.80');
    expect(out).toContain(t('decide.risk.limitMin', { value: '1.25' }));
  });

  it('хангаагүй харьцаа/LTV «Хангахгүй» гэж, хангасан «Хангана» гэж тэмдэглэгдэнэ', () => {
    const out = html(risk({ ratio: { kind: 'DTI', value: 0.61, limit: 0.55, pass: false }, ltv: { value: 0.8, limit: 0.7, pass: false } }));
    expect(out.split(t('score.verdict.fail')).length - 1).toBe(2);
    expect(out).not.toContain(t('score.verdict.pass'));
  });

  it('анхааруулгууд мессежээрээ жагсана (алдаа / сануулга)', () => {
    const out = html(risk({ flags: [{ code: 'NOT_VALUED', level: 'error', message: 'Барьцаа үнэлэгдээгүй' }, { code: 'CALCULATION_STALE', level: 'warning', message: 'Тооцоолол хуучирсан байна' }] }));
    expect(out).toContain('Барьцаа үнэлэгдээгүй');
    expect(out).toContain('Тооцоолол хуучирсан байна');
    expect(out).not.toContain(t('decide.risk.noFlags'));
  });

  it('хуучирсан тооцоолол: «Хуучирсан» тэмдэг', () => {
    expect(html(risk({ stale: true }))).toContain(t('decide.risk.stale'));
    expect(html(risk({ stale: false }))).not.toContain(t('decide.risk.stale'));
  });

  it('утгагүй талбар «—»: Sosco, LTV, харьцаа байхгүй; барьцаа шаардахгүй бол тусгай текст', () => {
    const out = html(risk({ ratio: null, ltv: { value: null, limit: 0.7, pass: null }, sosco: { score: null, grade: null }, collateral: { count: 0, totalValue: 0, required: false } }));
    expect(out).toContain(t('decide.risk.collateral.none'));
    expect(out).toContain('—');
    expect(out).not.toContain(t('score.verdict.pass'));
  });

  it('risk байхгүй / null бол хоосон карт биш, «тооцоолол хадгалагдаагүй» тодорхой мэдээлэл', () => {
    for (const r of [null, undefined]) {
      const out = html(r);
      expect(out).toContain('data-testid="risk-missing"');
      expect(out).toContain(t('decide.risk.missing'));
      expect(out).not.toContain('data-testid="risk-card"');
    }
  });
});
