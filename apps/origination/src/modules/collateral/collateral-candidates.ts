import {
  parseCollateralDescription, collateralAssetKey,
  type AssetType, type XypAssetsResponse, type XypPropertyAsset, type XypVehicleAsset,
} from '@los/contracts';

// FR-6.3 ХУР-аас татсан хөрөнгө → барьцаа үүсгэх урьдчилсан бөглөлт. ЦЭВЭР функц.

export interface RawCandidate {
  xypRef: string;
  assetType: AssetType;
  label: string;
  /** `CreateCollateralRequest.description`-д шууд хэрэглэх (хөрөнгийн төрлийн схемээр шалгагдсан). */
  description: Record<string, unknown>;
  assetKey: string | null;
}

const drop = <T extends Record<string, unknown>>(o: T): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

function propertyDescription(p: XypPropertyAsset): Record<string, unknown> {
  const common = { propertyId: p.propertyId, certificateNo: p.certificateNo, address: drop(p.address), areaM2: p.areaM2 };
  switch (p.assetType) {
    case 'APARTMENT': return drop({ ...common, floor: p.floor, totalFloors: p.totalFloors, rooms: p.rooms, buildYear: p.buildYear, purpose: p.purpose });
    case 'HOUSE': return drop({ ...common, floors: p.totalFloors, buildYear: p.buildYear, purpose: p.purpose });
    case 'LAND': return drop({ ...common, landUse: p.landUse });
  }
}

const vehicleDescription = (v: XypVehicleAsset): Record<string, unknown> =>
  drop({ plateNo: v.plateNo, vin: v.vin, make: v.make, model: v.model, manufactureYear: v.manufactureYear, importYear: v.importYear, engineCc: v.engineCc, fuelType: v.fuelType, color: v.color });

const propertyLabel = (p: XypPropertyAsset): string => {
  const kind = p.assetType === 'APARTMENT' ? 'Орон сууц' : p.assetType === 'HOUSE' ? 'Байшин' : 'Газар';
  const place = [p.address.district, p.address.khoroo].filter(Boolean).join(', ');
  return `${kind} · ${place} · ${p.areaM2} м²`;
};
const vehicleLabel = (v: XypVehicleAsset): string => `${v.make} ${v.model} ${v.manufactureYear} · ${v.plateNo}`;

/**
 * Үл хөдлөх (APARTMENT | HOUSE | LAND), тээврийн хэрэгсэл (VEHICLE) тус бүрээс candidate гаргана. Схемд нийцэхгүй (барьцаа болгон шууд үүсгэх боломжгүй)
 * хөрөнгийг орхиж, тоог `skipped`-д буцаана (лог руу хувийн мэдээлэлгүйгээр тоо л бичигдэнэ).
 */
export function toCandidates(assets: XypAssetsResponse): { items: RawCandidate[]; skipped: number } {
  const items: RawCandidate[] = [];
  let skipped = 0;
  const add = (xypRef: string, assetType: AssetType, label: string, raw: Record<string, unknown>): void => {
    try {
      const description = parseCollateralDescription(assetType, raw) as Record<string, unknown>;
      items.push({ xypRef, assetType, label, description, assetKey: collateralAssetKey(assetType, description) });
    } catch {
      skipped += 1;
    }
  };
  for (const p of assets.properties) add(p.propertyId, p.assetType, propertyLabel(p), propertyDescription(p));
  for (const v of assets.vehicles) add(v.plateNo, 'VEHICLE', vehicleLabel(v), vehicleDescription(v));
  return { items, skipped };
}
