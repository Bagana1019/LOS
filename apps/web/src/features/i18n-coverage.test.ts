import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AssetType, BorrowerRole, GateIssueCode, HaircutSource, LandUse, LivestockAgeGroup, LivestockType, RealtyPurpose, SuggestionUnavailableReason, SuggestionWarning,
  ValuationMethod, ValuationSource, VehicleFuelType, CollateralSource, CollateralWarningCode, DocumentOcrVerdict, EncumbranceStatus,
} from '@los/contracts';
import { mnSources } from '@los/ui';
import { messageKeys } from '../lib/i18n';
import { FIELD_SPECS } from './collateral/collateral.fields';

// Барьцаа, баримтын алхмын i18n бүрэн байдал: (1) эх кодонд бичсэн `collateral.*` / `document.*` түлхүүр бүр толь бичигт байна,
// (2) enum-оос үүссэн динамик түлхүүрийн бүлэг (`collateral.issue.<КОД>.title` …) бүрэн. Дутвал UI дээр түлхүүр өөрөө (жишээ `collateral.issue.X.title`) гарна.

const here = fileURLToPath(new URL('.', import.meta.url));
const dictionary = new Set(messageKeys());

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !/\.fixtures\.ts$/.test(e.name) ? [full] : [];
  });
}

const KEY = /['"`]((?:collateral|document)\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"`]/g;

describe('эх кодонд бичсэн түлхүүр бүр толь бичигт байна', () => {
  const files = [...sourceFiles(join(here, 'collateral')), ...sourceFiles(join(here, 'documents'))];

  it('эх файлууд олдсон', () => expect(files.length).toBeGreaterThan(30));

  it('literal түлхүүр', () => {
    const missing: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(KEY)) {
        const key = match[1] as string;
        // `collateral.fuelType.` гэх мэт угтвар (төгсгөлд цэг) KEY-д орохгүй; динамик `${…}` хэсэгтэй түлхүүр доор enum-оор шалгагдана
        if (!dictionary.has(key)) missing.push(`${key}  (${file.slice(here.length)})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('угтвараар бүтсэн түлхүүрийн угтвар (optionPrefix) бүрийн дор орчуулга бий', () => {
    for (const assetType of AssetType) {
      for (const spec of FIELD_SPECS[assetType]) {
        if (!spec.optionPrefix) continue;
        for (const option of spec.options ?? []) expect(dictionary.has(`${spec.optionPrefix}${option}`), `${spec.optionPrefix}${option}`).toBe(true);
      }
    }
  });
});

describe('динамик түлхүүрийн бүлгүүд enum бүрийн утгыг хамарна', () => {
  const families: Array<[string, readonly string[]]> = [
    ['collateral.assetType.', AssetType],
    ['collateral.role.', BorrowerRole],
    ['collateral.source.', CollateralSource],
    ['collateral.purpose.', RealtyPurpose],
    ['collateral.landUse.', LandUse],
    ['collateral.livestockType.', LivestockType],
    ['collateral.ageGroup.', LivestockAgeGroup],
    ['collateral.fuelType.', VehicleFuelType],
    ['collateral.valuationSource.', ValuationSource],
    ['collateral.valuationMethod.', ValuationMethod],
    ['collateral.haircutSource.', HaircutSource],
    ['collateral.confidence.', ['HIGH', 'MEDIUM', 'LOW']],
    ['collateral.suggestionWarning.', SuggestionWarning],
    ['collateral.unavailableReason.', [...SuggestionUnavailableReason, 'UNKNOWN']],
    ['collateral.warning.', CollateralWarningCode],
    ['collateral.monitoring.reason.', ['REVALUATION_DUE', 'INSURANCE_EXPIRING', 'INSURANCE_EXPIRED', 'LTV_BREACH']],
    ['collateral.status.ownership.', ['NOT_CHECKED', 'STALE', 'VERIFIED', 'OWNER_MISMATCH', 'OWNER_NOT_ON_APPLICATION']],
    ['collateral.status.encumbrance.', ['NOT_CHECKED', 'STALE', ...EncumbranceStatus]],
    ['collateral.status.valuation.', ['NOT_VALUED', 'EXPIRED', 'EXTERNAL_REQUIRED', 'EXTERNAL', 'VALUED']],
    ['collateral.checks.method.', ['REGISTRY', 'DECLARED']],
    ['collateral.checks.methodHint.', ['REGISTRY', 'DECLARED']],
    ['collateral.checks.run.ownership.', ['REGISTRY', 'DECLARED']],
    ['collateral.checks.run.encumbrance.', ['REGISTRY', 'DECLARED']],
    ['collateral.checks.source.', ['XYP', 'ATUT', 'DECLARED']],
    ['collateral.checks.encSource.', ['ZMS', 'EB']],
    ['collateral.checks.encSourceStatus.', ['CLEAR', 'ENCUMBERED', 'DISPUTED', 'NOT_APPLICABLE']],
    ['collateral.gate.state.', ['complete', 'skipped', 'incomplete']],
    ['collateral.gate.goStep.', ['client', 'loan']],
    ['collateral.issue.severity.', ['error', 'warning']],
    ['document.ocr.verdict.', DocumentOcrVerdict],
    ['document.ocr.advice.', DocumentOcrVerdict],
    ['document.role.', BorrowerRole],
  ];
  it.each(families.map(([prefix, values]) => [prefix, values] as const))('%s', (prefix, values) => {
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(dictionary.has(`${prefix}${value}`), `${prefix}${value}`).toBe(true);
  });

  it('G0 дутагдлын код бүр гарчиг + зөвлөмжтэй', () => {
    for (const code of GateIssueCode) {
      expect(dictionary.has(`collateral.issue.${code}.title`), code).toBe(true);
      expect(dictionary.has(`collateral.issue.${code}.hint`), code).toBe(true);
    }
  });
});

describe('толь бичиг', () => {
  it('collateral файлд зөвхөн collateral.*, document файлд зөвхөн document.*', () => {
    expect(Object.keys(mnSources.collateral).filter((k) => !k.startsWith('collateral.'))).toEqual([]);
    expect(Object.keys(mnSources.documents).filter((k) => !k.startsWith('document.'))).toEqual([]);
  });
  it('ашиглагдаагүй түлхүүр ердөө байхгүй: толь бичгийн түлхүүр бүр кодонд (literal эсвэл бүлгээр) орсон', () => {
    const files = [...sourceFiles(join(here, 'collateral')), ...sourceFiles(join(here, 'documents'))];
    const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    const literals = new Set([...text.matchAll(KEY)].map((m) => m[1] as string));
    const prefixes = [...text.matchAll(/['"`]((?:collateral|document)\.[A-Za-z0-9_.]*)(?:\$\{|['"`])/g)].map((m) => m[1] as string).filter((p) => p.endsWith('.'));
    const own = [...Object.keys(mnSources.collateral), ...Object.keys(mnSources.documents)];
    // `<scope>.error.<КОД>` ба `<scope>.action.retry` нь scope параметрээр угсрагддаг (documents/shared/api-error.ts, ApiErrorAlert) — api-error.test.ts шалгана
    const scoped = (key: string) => /^(collateral|document)\.error\./.test(key) || /^(collateral|document)\.action\.retry$/.test(key);
    const unused = own.filter((key) => !scoped(key) && !literals.has(key) && !prefixes.some((p) => key.startsWith(p)));
    expect(unused).toEqual([]);
  });
});
