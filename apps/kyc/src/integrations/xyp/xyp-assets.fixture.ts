import type { CustomerType, LandUse, RealtyAddress, RealtyPurpose, XypAssetsResponse, XypCitizen, XypPropertyAsset, XypPropertyOwner, XypVehicleAsset } from '@los/contracts';
import { customerTypeOfRegister, normalizeRegisterNo } from '@los/contracts';
import { XYP_FIXTURE_FETCHED_AT, hash, pick, xypFixture } from './xyp.fixture';

// DEMO: ХУР-ын хөрөнгийн (үл хөдлөх, тээвэр) mock fixture — FR-6.3, FR-6.5. БҮХ нэр, хаяг, дугаар зохиомол, бодит хөрөнгө биш.
// Deterministic (CLAUDE.md §3.2.7): Math.random/Date.now ашиглахгүй, ижил регистрт үргэлж ижил хариу. Регистр нь хувийн мэдээлэл — лог-д бичихгүй,
// хадгалахгүй (зөвхөн дуудагчид буцна). Бодит ХУР холбогдохоор энэ файл ашиглагдахаа болино (`INTEGRATION_MODE=real` → RealXypClient).

/** Тусгай өмчлөх эрхийн дугаарын DEMO формат: `MOCK-<РЕГИСТР>-<n>`. `getProperty` дугаараас өмчлөгчийг буцааж гаргана. */
export const XYP_MOCK_PROPERTY_ID_PREFIX = 'MOCK';
/** `n = 9` — хоёр дахь өмчлөгчтэй (хамтран өмчлөгч) хөрөнгө: `OWNER_NOT_ON_APPLICATION` (docs/05 §6)-ийг үзүүлэх DEMO. */
export const XYP_CO_OWNED_PROPERTY_NO = 9;

const propertyIdOf = (registerNo: string, n: number): string => `${XYP_MOCK_PROPERTY_ID_PREFIX}-${registerNo}-${n}`;
const PROPERTY_ID = /^MOCK-([^-]+)-([1-9]\d?)$/i;

// ── Тээврийн хэрэгсэл ─────────────────────────────────────────────────────────────────────────────────────────────────────
// DEMO: Эдгээр мөр нь apps/valuation/src/integrations/vehicle-registry/mock-vehicles.ts (valuation-ий mock АТҮТ)-тэй ТАЛБАР БҮРЭЭРЭЭ ижил байх
// ёстой — улсын дугаар, өмчлөгчийн регистр, марк/загвар/он/хөдөлгүүр/өнгө. Хоёр fixture-ийг ХАМТ шинэчилнэ: valuation талд энэ тухай тэмдэглэл
// байхгүй тул ЗӨВХӨН энд л сануулна. Зөрвөл `apps/kyc/test/xyp-vehicles-sync.test.ts` унана; `xyp-assets.fixture.test.ts` нь утгыг тогтоосон.
// Өмчлөгчийн нэр энд байхгүй (XypVehicleAsset-д өмчлөгч талбар байхгүй, регистр нь холбоос).
export interface XypMockVehicle { ownerRegisterNo: string; vehicle: XypVehicleAsset }
export const XYP_MOCK_VEHICLES: readonly XypMockVehicle[] = [
  { ownerRegisterNo: 'УЕ00000001', vehicle: { plateNo: 'УЕН5246', vin: 'MOCKVIN0000000001', make: 'Toyota', model: 'Prius', manufactureYear: 2012, importYear: 2016, engineCc: 1798, fuelType: 'HYBRID', color: 'Цагаан' } },
  { ownerRegisterNo: '0000001', vehicle: { plateNo: '1234УБА', vin: 'MOCKVIN0000000002', make: 'Toyota', model: 'Land Cruiser Prado', manufactureYear: 2015, importYear: 2018, engineCc: 2755, fuelType: 'DIESEL', color: 'Хар' } },
  { ownerRegisterNo: 'ЖИ00000002', vehicle: { plateNo: '5678УНА', vin: 'MOCKVIN0000000003', make: 'Hyundai', model: 'Sonata', manufactureYear: 2017, importYear: 2019, engineCc: 1999, fuelType: 'LPG', color: 'Мөнгөлөг' } },
  { ownerRegisterNo: 'ТЭ00000003', vehicle: { plateNo: '7001УБЭ', vin: 'MOCKVIN0000000004', make: 'Lexus', model: 'LX 570', manufactureYear: 2018, importYear: 2020, engineCc: 5663, fuelType: 'PETROL', color: 'Хар' } },
  { ownerRegisterNo: '0000002', vehicle: { plateNo: '3030БАА', vin: 'MOCKVIN0000000005', make: 'Daewoo', model: 'Damas', manufactureYear: 2005, importYear: null, engineCc: 796, fuelType: 'PETROL', color: null } },
];

// ── Үл хөдлөх хөрөнгө ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Хаяг зохиомол (байр/тоот/гудамжийн дугаар hash-аас). Дүүрэг, хорооны нэр нь xyp.fixture.ts-тэй ижил хэв маяг.
interface Locality { province: string; district: string; khoroo: string; place: string }
const LOCALITIES: readonly Locality[] = [
  { province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: '5-р хороо', place: 'Хан-Уул хотхон' },
  { province: 'Улаанбаатар', district: 'Сүхбаатар', khoroo: '1-р хороо', place: 'Бага тойруу' },
  { province: 'Улаанбаатар', district: 'Хан-Уул', khoroo: '11-р хороо', place: 'Зайсан' },
  { province: 'Дархан-Уул', district: 'Дархан', khoroo: '4-р баг', place: 'Нисэх' },
  { province: 'Орхон', district: 'Баян-Өндөр', khoroo: '2-р баг', place: 'Гүнтэв' },
  { province: 'Улаанбаатар', district: 'Чингэлтэй', khoroo: '6-р хороо', place: 'Нарны зам' },
];
type RealtyKind = XypPropertyAsset['assetType'];
const PURPOSE_OF: Record<CustomerType, RealtyPurpose> = { INDIVIDUAL: 'RESIDENTIAL', LEGAL_ENTITY: 'COMMERCIAL' };

function addressOf(kind: RealtyKind, h: number): RealtyAddress {
  const loc = pick(LOCALITIES, h >>> 3);
  const detail =
    kind === 'APARTMENT' ? `${loc.place}, ${1 + ((h >>> 7) % 40)}-р байр, ${1 + ((h >>> 11) % 120)} тоот`
    : kind === 'HOUSE' ? `${loc.place}, ${1 + ((h >>> 7) % 300)}-р гудамж, ${1 + ((h >>> 11) % 60)} тоот`
    : `${loc.place}, ${1 + ((h >>> 7) % 500)}-р талбай`;
  return { province: loc.province, district: loc.district, khoroo: loc.khoroo, detail };
}

/** Нэг хөрөнгө. `owners` нь дуудагчаас ирнэ (нэг эсвэл хоёр өмчлөгч). Бүх талбар `h`-ээс тогтвортой (ижил дугаарт ижил хөрөнгө). */
function buildProperty(registerNo: string, type: CustomerType, n: number, owners: XypPropertyOwner[]): XypPropertyAsset {
  const propertyId = propertyIdOf(registerNo, n);
  const h = hash(propertyId);
  // Иргэн: 1 → орон сууц/байшин; 2 → газар/байшин; 9 (хамтран өмчлөгчтэй) → орон сууц/байшин. Байгууллага: нэг үйлчилгээний (COMMERCIAL) хөрөнгө.
  const kind: RealtyKind =
    type === 'LEGAL_ENTITY' ? pick<RealtyKind>(['APARTMENT', 'HOUSE'], h >>> 5)
    : n === 2 ? pick<RealtyKind>(['LAND', 'HOUSE', 'LAND'], h >>> 5)
    : pick<RealtyKind>(['APARTMENT', 'HOUSE', 'APARTMENT'], h >>> 5);
  const certificateNo = `DEMO-CERT-${String(h % 1_000_000).padStart(6, '0')}`;
  const base = { propertyId, certificateNo, assetType: kind, address: addressOf(kind, h), owners };
  const buildYear = 1985 + ((h >>> 19) % 39);
  if (kind === 'APARTMENT') {
    const totalFloors = 5 + ((h >>> 9) % 12);
    return { ...base, areaM2: 32 + ((h >>> 13) % 90), floor: 1 + ((h >>> 15) % totalFloors), totalFloors, rooms: 1 + ((h >>> 17) % 4), buildYear, purpose: PURPOSE_OF[type], landUse: null };
  }
  if (kind === 'HOUSE') {
    return { ...base, areaM2: 60 + ((h >>> 13) % 141), floor: null, totalFloors: 1 + ((h >>> 9) % 2), rooms: 3 + ((h >>> 17) % 4), buildYear, purpose: PURPOSE_OF[type], landUse: null };
  }
  const landUse: LandUse = type === 'LEGAL_ENTITY' ? 'COMMERCIAL' : pick<LandUse>(['RESIDENTIAL', 'RESIDENTIAL', 'COMMERCIAL'], h >>> 9);
  return { ...base, areaM2: 300 + 100 * ((h >>> 13) % 8), floor: null, totalFloors: null, rooms: null, buildYear: null, purpose: null, landUse };
}

/** Өмчлөгчийн нэр: ХУР-ын иргэн/байгууллагын fixture-тэй ижил (`xypFixture`). */
const nameOf = (c: XypCitizen): string => (c.customerType === 'INDIVIDUAL' ? `${c.lastName ?? ''} ${c.firstName}`.trim() : c.firstName);

/**
 * Хамтран өмчлөгчийн ЗОХИОМОЛ иргэний регистр (регистрээс тогтвортой). Тоо нь 10,000,000–89,999,999: "олдохгүй/унасан" тусгай регистртэй давхцахгүй.
 * Нэр нь өмчлөгчийн нэрээс ялгаатай байхаар (demo-д хоёр өөр хүн харагдах) давхцвал давхцахгүй болтол дахин үүсгэнэ (тогтвортой).
 */
export function xypCoOwnerRegister(registerNo: string): string {
  const owner = xypFixture(registerNo);
  const ownerName = owner ? nameOf(owner) : null;
  let candidate = '';
  for (let salt = 0; salt < 50; salt++) {
    const key = salt === 0 ? registerNo : `${registerNo}:${salt}`;
    const letters = pick(['ЭХ', 'ХД', 'ЧЛ', 'ГБ', 'ӨА', 'ЛЖ'], hash(`${key}:co-owner-letters`));
    candidate = `${letters}${10_000_000 + (hash(`${key}:co-owner`) % 80_000_000)}`;
    const citizen = xypFixture(candidate);
    if (citizen && nameOf(citizen) !== ownerName) return candidate;
  }
  return candidate;
}

/** Регистрийн жагсаалтад ордог DEMO дугаарууд (өсөхөөр). Байгууллага: [1]. Иргэн: [1] (50%), [1, 2] (25%), [1, 9] (25%, 9 нь хамтран өмчлөгчтэй). */
export function xypPropertyNos(registerNo: string, type: CustomerType): number[] {
  if (type === 'LEGAL_ENTITY') return [1];
  const seed = hash(registerNo);
  if ((seed >>> 12) % 2 === 0) return [1];
  return (seed >>> 15) % 2 === 0 ? [1, XYP_CO_OWNED_PROPERTY_NO] : [1, 2];
}

/** Регистрийн бүх үл хөдлөх хөрөнгө (өмчлөгчийн нэр = ХУР-ын fixture). Ойлгомжтой байлгахаар `citizen` нь заавал ХУР-д бүртгэлтэй регистр. */
function propertiesOf(citizen: XypCitizen): XypPropertyAsset[] {
  const type = citizen.customerType;
  const owner = (sharePercent: number): XypPropertyOwner => ({ registerNo: citizen.registerNo, name: nameOf(citizen), sharePercent });
  return xypPropertyNos(citizen.registerNo, type).map((n) => {
    if (n !== XYP_CO_OWNED_PROPERTY_NO) return buildProperty(citizen.registerNo, type, n, [owner(100)]);
    const coRegister = xypCoOwnerRegister(citizen.registerNo);
    const co = xypFixture(coRegister);
    // co-owner-ийн регистр үргэлж зөв хэлбэртэй, тусгай цифргүй тул fixture заавал байна.
    const coName = co ? nameOf(co) : 'Жишээ Хамтран өмчлөгч';
    return buildProperty(citizen.registerNo, type, n, [owner(50), { registerNo: coRegister, name: coName, sharePercent: 50 }]);
  });
}

/**
 * @param registerNo нормчилсон регистр.
 * `null` = ХУР-д байхгүй (мөн буруу хэлбэртэй); `undefined` = ХУР унасан (mock-ийн тусгай регистр, `xypFixture`-тэй ижил).
 */
export function xypAssetsFixture(registerNo: string): XypAssetsResponse | null | undefined {
  const citizen = xypFixture(registerNo);
  if (!citizen) return citizen;
  return {
    properties: propertiesOf(citizen),
    vehicles: XYP_MOCK_VEHICLES.filter((v) => v.ownerRegisterNo === registerNo).map((v) => ({ ...v.vehicle })),
    fetchedAt: XYP_FIXTURE_FETCHED_AT,
  };
}

/** Өмчлөх эрхийн дугаараар (`MOCK-<РЕГИСТР>-<n>`) хөрөнгө, өмчлөгчид. `null` = дугаар танигдсангүй/жагсаалтад байхгүй; `undefined` = ХУР унасан. */
export function xypPropertyFixture(propertyId: string): XypPropertyAsset | null | undefined {
  const m = PROPERTY_ID.exec(propertyId.trim());
  if (!m) return null;
  const registerNo = normalizeRegisterNo(m[1]!);
  if (!customerTypeOfRegister(registerNo)) return null;
  const assets = xypAssetsFixture(registerNo);
  if (!assets) return assets;
  return assets.properties.find((p) => p.propertyId === propertyIdOf(registerNo, Number(m[2]))) ?? null;
}
