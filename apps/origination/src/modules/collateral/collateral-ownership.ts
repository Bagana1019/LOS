import { maskRegisterNo } from '@los/database';
import { normalizeRegisterNo, type AssetType, type BorrowerRole, type OwnershipCheck, type OwnershipStatus } from '@los/contracts';
import { OWNER_ROLES, REGISTER_PLEDGOR_HINT } from './collateral.constants';

// FR-6.5 өмчлөлийн KYC ба FR-6.6 ачааллын эх сурвалжийн дүрэм. ЦЭВЭР функцүүд (I/O байхгүй).
// DEMO: аль хөрөнгийн төрөлд бүртгэл (АТҮТ, ХУР, ЭБ) байгааг интеграци бүрийн боломжоор тодорхойлсон — шинэ бүртгэл холбогдвол ЭНД л нэмнэ.

export type OwnershipSource = 'ATUT' | 'XYP';
/** Өмчлөгчийг бүртгэлээс татаж тулгах боломжтой төрлүүд: автомашин → АТҮТ (valuation vehicle-lookup), үл хөдлөх → ХУР (kyc xyp/property). */
const OWNERSHIP_REGISTRY: Partial<Record<AssetType, OwnershipSource>> = { VEHICLE: 'ATUT', APARTMENT: 'XYP', HOUSE: 'XYP', LAND: 'XYP' };
/** Ачааллыг ЗМС + ЭБ-ээс шалгах боломжтой төрлүүд (kyc `collateral-checks/encumbrance`). EQUIPMENT нь серийн дугаартай үед. */
const ENCUMBRANCE_REGISTRY: readonly AssetType[] = ['VEHICLE', 'APARTMENT', 'HOUSE', 'LAND', 'EQUIPMENT'];

export const ownershipRegistrySource = (assetType: AssetType): OwnershipSource | null => OWNERSHIP_REGISTRY[assetType] ?? null;

/** `method=DECLARED` (ЗЭЗ баталгаажуулна) нь өмчлөлийн бүртгэлгүй хөрөнгөд л зөвшөөрөгдөнө. */
export const ownershipDeclaredAllowed = (assetType: AssetType): boolean => ownershipRegistrySource(assetType) === null;
export const encumbranceRegistryAvailable = (assetType: AssetType): boolean => ENCUMBRANCE_REGISTRY.includes(assetType);
/** Ачааллын DECLARED нь ЗМС/ЭБ-д шалгах боломжгүй төрөлд (мал, бараа, тоног төхөөрөмж, бусад); автомашин, үл хөдлөх заавал бүртгэлээр. */
export const encumbranceDeclaredAllowed = (assetType: AssetType): boolean => !['VEHICLE', 'APARTMENT', 'HOUSE', 'LAND'].includes(assetType);

const str = (d: Record<string, unknown>, k: string): string | null => (typeof d[k] === 'string' && (d[k] as string).trim() ? (d[k] as string).trim() : null);

/** kyc `EncumbranceCheckRequest.identifier`: VEHICLE → улсын дугаар; үл хөдлөх → өмчлөх эрхийн дугаар (эсвэл гэрчилгээ); EQUIPMENT → серийн дугаар. */
export function encumbranceIdentifier(assetType: AssetType, description: Record<string, unknown>): string | null {
  switch (assetType) {
    case 'VEHICLE': return str(description, 'plateNo');
    case 'APARTMENT':
    case 'HOUSE':
    case 'LAND': return str(description, 'propertyId') ?? str(description, 'certificateNo');
    case 'EQUIPMENT': return str(description, 'serialNo');
    default: return null;
  }
}

/** Регистрийг лог/хариунд задлахгүйн тулд далдлана: иргэн `УБ****5678`; богино (байгууллагын 7 орон) бол илүү хатуу далдлана. */
export function maskRegister(registerNo: string): string {
  const n = normalizeRegisterNo(registerNo);
  return n.length >= 10 ? maskRegisterNo(n) : '*'.repeat(Math.max(0, n.length - 2)) + n.slice(-2);
}

const BEST_ROLE_ORDER: readonly BorrowerRole[] = ['PRIMARY', 'CO_BORROWER', 'PLEDGOR', 'GUARANTOR'];
/** Нэг харилцагчийн хүсэлтэд эзэлж буй дүрүүдээс хамгийн хүчтэй нь (өмчлөгч байж болох дүр давамгайлна). */
export function bestRole(roles: readonly BorrowerRole[]): BorrowerRole | null {
  return BEST_ROLE_ORDER.find((r) => roles.includes(r)) ?? null;
}
export const isOwnerRole = (role: BorrowerRole | null): boolean => role != null && (OWNER_ROLES as readonly string[]).includes(role);

/** Бүртгэлийн өмчлөгч (регистрээр) хүсэлтийн оролцогчтой тулгагдсан байдал. */
export interface MatchedOwner {
  registerMasked: string;
  name: string;
  /** Тулгагдсан харилцагч, хэрэв хүсэлтийн оролцогч бол (дүр ямар ч байсан). */
  matchedCustomerId: string | null;
  role: BorrowerRole | null;
}

/**
 * Өмчлөлийн дүгнэлт (FR-6.5):
 *  - бүртгэлийн ӨМЧЛӨГЧ БҮР хүсэлтийн барьцаалагч (PRIMARY / CO_BORROWER / PLEDGOR) байх ёстой, үгүй бол OWNER_NOT_ON_APPLICATION
 *    ("Барьцаалагч бүртгэнэ үү" — 1-р алхамд нэмнэ). Зөвхөн батлан даагчаар бүртгэгдсэн өмчлөгч мөн үүнд тооцогдоно.
 *  - бүгд оролцогч ч сонгосон барьцаалагч тэдний дунд байхгүй бол OWNER_MISMATCH;
 *  - эс бөгөөс VERIFIED.
 */
export function judgeOwnership(owners: readonly MatchedOwner[], collateralOwnerCustomerId: string | null): { status: OwnershipStatus; message: string | null } {
  if (owners.length === 0 || owners.some((o) => !o.matchedCustomerId || !isOwnerRole(o.role))) {
    return { status: 'OWNER_NOT_ON_APPLICATION', message: `Бүртгэлийн өмчлөгч хүсэлтийн оролцогч биш байна. ${REGISTER_PLEDGOR_HINT}` };
  }
  if (!collateralOwnerCustomerId || !owners.some((o) => o.matchedCustomerId === collateralOwnerCustomerId)) {
    return { status: 'OWNER_MISMATCH', message: 'Бүртгэлийн өмчлөгч нь сонгосон барьцаалагчтай таарахгүй байна. Барьцаалагчийг засна уу' };
  }
  return { status: 'VERIFIED', message: null };
}

/** `ownership_check_json`: зөвхөн далдлагдсан регистр, нэр, тулгагдсан харилцагч, дүр. */
export function buildOwnershipCheck(args: {
  method: OwnershipCheck['method']; source: OwnershipCheck['source']; checkedAt: Date; owners: readonly MatchedOwner[];
  collateralOwnerCustomerId: string | null; note?: string | null;
}): OwnershipCheck {
  const { status, message } = judgeOwnership(args.owners, args.collateralOwnerCustomerId);
  return {
    status, method: args.method, source: args.source, checkedAt: args.checkedAt.toISOString(),
    owners: args.owners.map((o) => ({ registerMasked: o.registerMasked, name: o.name, matchedCustomerId: o.matchedCustomerId, role: o.role })),
    message, note: args.note ?? null,
  };
}
