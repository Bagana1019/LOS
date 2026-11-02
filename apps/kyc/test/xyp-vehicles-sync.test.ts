import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { XYP_MOCK_VEHICLES } from '../src/integrations/xyp/xyp-assets.fixture';

// DEMO: kyc-ийн mock ХУР-ын тээврийн хэрэгслүүд нь valuation-ий mock АТҮТ-тэй (apps/valuation/.../vehicle-registry/mock-vehicles.ts) ТАЛБАР БҮРЭЭРЭЭ
// ижил байх ёстой (FR-6.5: ХУР-ын өмчлөгч = АТҮТ-ийн өмчлөгч гэсэн DEMO). Хоёр сервисийн кодыг импортлохгүй — valuation-ий файлыг текстээр уншиж тулгана.
// Файл олдохгүй бол (жишээ нь зөвхөн apps/kyc-г багцалсан орчин) тест алгасагдана; монорепод заавал ажиллана.
const VALUATION_FILE = resolve(__dirname, '../../valuation/src/integrations/vehicle-registry/mock-vehicles.ts');

interface Row { plateNo: string; vin: string | null; make: string; model: string; manufactureYear: number; importYear: number | null; engineCc: number | null; fuelType: string | null; color: string | null; owner: string }

const str = (chunk: string, key: string): string | null => {
  const m = new RegExp(`\\b${key}:\\s*(?:'([^']*)'|(null))`).exec(chunk);
  if (!m) throw new Error(`key "${key}" not found in the valuation mock vehicle`);
  return m[2] ? null : m[1]!;
};
const num = (chunk: string, key: string): number | null => {
  const m = new RegExp(`\\b${key}:\\s*(\\d+|null)\\b`).exec(chunk);
  if (!m) throw new Error(`key "${key}" not found in the valuation mock vehicle`);
  return m[1] === 'null' ? null : Number(m[1]);
};

function parseValuationVehicles(source: string): Row[] {
  // Коммент, ялангуяа "plateNo" гэж дурдсан мөрийг хасаад, `plateNo:` бүрээр мөр болгож хуваана.
  const code = source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  return code
    .split(/\bplateNo:/)
    .slice(1)
    .map((rest) => {
      const chunk = `plateNo:${rest}`;
      return {
        plateNo: str(chunk, 'plateNo')!,
        vin: str(chunk, 'vin'),
        make: str(chunk, 'make')!,
        model: str(chunk, 'model')!,
        manufactureYear: num(chunk, 'manufactureYear')!,
        importYear: num(chunk, 'importYear'),
        engineCc: num(chunk, 'engineCc'),
        fuelType: str(chunk, 'fuelType'),
        color: str(chunk, 'color'),
        owner: /owner:\s*\{\s*registerNo:\s*'([^']+)'/.exec(chunk)![1]!,
      };
    });
}

describe.skipIf(!existsSync(VALUATION_FILE))('kyc mock ХУР vehicles vs valuation mock АТҮТ registry', () => {
  const valuation = existsSync(VALUATION_FILE) ? parseValuationVehicles(readFileSync(VALUATION_FILE, 'utf8')) : [];

  it('the parser found the valuation mock vehicles (guards against a silent no-op)', () => {
    expect(valuation.length).toBeGreaterThanOrEqual(5);
  });

  it('has the same vehicles, in the same order, with the same owner registers and fields', () => {
    expect(XYP_MOCK_VEHICLES.map((v) => ({ ...v.vehicle, owner: v.ownerRegisterNo }))).toEqual(valuation);
  });
});
