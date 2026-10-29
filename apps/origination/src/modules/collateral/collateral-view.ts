import {
  EncumbranceCheckView, OwnershipCheck, collateralChecklistLabel, COLLATERAL_OTHER_DOC_KEY,
  type AssetType, type BorrowerRole, type CollateralChecklistItem, type CollateralDocumentView, type CollateralSource, type CollateralView, type GateIssue, type ValuationSnapshot,
} from '@los/contracts';
import type { Collateral, CollateralDocument } from '.prisma/client-origination';
import { descriptionOf, isoDate, num } from './collateral-data';
import { externalValuationRequired, isValued, resolveChecklist, type GateCollateralInput, type GateProduct } from './collateral-gate';

export type CollateralRow = Collateral & { documents: CollateralDocument[] };

/** Хадгалагдсан JSON-г схемээр шалгана; буруу/хуучин хэлбэр → null (шалгалт хийгдээгүй гэж үзнэ — fail closed). */
export const parseOwnership = (v: unknown): OwnershipCheck | null => {
  const r = OwnershipCheck.safeParse(v);
  return r.success ? r.data : null;
};
export const parseEncumbrance = (v: unknown): EncumbranceCheckView | null => {
  const r = EncumbranceCheckView.safeParse(v);
  return r.success ? r.data : null;
};

export const toDocumentView = (d: CollateralDocument): CollateralDocumentView => ({
  id: d.id, checklistKey: d.checklistKey, fileId: d.fileId, fileName: d.fileName, mime: d.mime, size: d.size, note: d.note, uploadedBy: d.uploadedBy, uploadedAt: d.uploadedAt.toISOString(),
});

/** Барьцааны мөр → G0-ийн цэвэр функцийн орц. */
export function toGateCollateral(row: CollateralRow, ownerRole: BorrowerRole | null): GateCollateralInput {
  return {
    id: row.id, assetType: row.assetType as AssetType, ownerCustomerId: row.ownerCustomerId, ownerRole,
    ownership: parseOwnership(row.ownershipCheckJson), encumbrance: parseEncumbrance(row.encumbranceCheckJson),
    marketValue: num(row.marketValue), collateralValue: num(row.collateralValue), valuationId: row.valuationId, valuationSource: row.valuationSource as GateCollateralInput['valuationSource'],
    valuedAt: row.valuedAt, valuationValidUntil: row.valuationValidUntil, externalValuationRequired: row.externalValuationRequired,
    documentKeys: row.documents.map((d) => d.checklistKey), releasedAt: row.releasedAt,
  };
}

/** FR-14.2–14.3: үнэлгээний хураангуй (хүчинтэй хугацаа дууссан эсэх, гадны үнэлгээ шаардлага). */
export function toValuationSnapshot(row: CollateralRow, g: GateCollateralInput, product: GateProduct | null, now: Date): ValuationSnapshot | null {
  if (!isValued(g)) return null;
  const required = externalValuationRequired(g, product);
  return {
    valuationId: g.valuationId, source: g.valuationSource, valuedAt: g.valuedAt.toISOString(), validUntil: g.valuationValidUntil?.toISOString() ?? null,
    expired: g.valuationValidUntil != null && now.getTime() > g.valuationValidUntil.getTime(),
    marketValue: g.marketValue, haircutRate: num(row.haircutRate) ?? 0, collateralValue: g.collateralValue, overrideReason: row.valuationOverrideReason,
    externalRequired: required, externalSatisfied: !required || g.valuationSource === 'EXTERNAL_LICENSED',
  };
}

export interface ViewContext {
  now: Date;
  product: GateProduct | null;
  ownerName: string | null;
  ownerRole: BorrowerRole | null;
  issues: readonly GateIssue[];
}

/** FR-6.7: product checklist (түлхүүрүүд) + хавсаргасан баримт. Checklist-д байхгүй түлхүүртэй (`other` г.м) баримт `extraDocuments`-д. */
export function toChecklist(row: CollateralRow, product: GateProduct | null): { checklist: CollateralChecklistItem[]; extraDocuments: CollateralDocumentView[] } {
  const rules = resolveChecklist(product?.collateralChecklist, row.assetType as AssetType);
  const keys = new Set(rules.map((r) => r.key));
  const docs = [...row.documents].sort((a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime() || a.id.localeCompare(b.id));
  return {
    checklist: rules.map((r) => {
      const documents = docs.filter((d) => d.checklistKey === r.key).map(toDocumentView);
      return { key: r.key, label: collateralChecklistLabel(r.key), required: r.required, satisfied: documents.length > 0, documents };
    }),
    extraDocuments: docs.filter((d) => !keys.has(d.checklistKey) || d.checklistKey === COLLATERAL_OTHER_DOC_KEY).map(toDocumentView),
  };
}

export function toCollateralView(row: CollateralRow, ctx: ViewContext): CollateralView {
  const gateInput = toGateCollateral(row, ctx.ownerRole);
  const { checklist, extraDocuments } = toChecklist(row, ctx.product);
  return {
    id: row.id, applicationId: row.applicationId, kind: row.kind, assetType: row.assetType as AssetType, description: descriptionOf(row), source: row.source as CollateralSource,
    owner: { customerId: row.ownerCustomerId, displayName: ctx.ownerName, role: ctx.ownerRole },
    registryNo: row.registryNo, registryDate: isoDate(row.registryDate), insuranceExpiresAt: isoDate(row.insuranceExpiresAt), nextRevaluationAt: isoDate(row.nextRevaluationAt),
    releasedAt: row.releasedAt?.toISOString() ?? null, note: row.note,
    ownership: gateInput.ownership, encumbrance: gateInput.encumbrance,
    valuation: toValuationSnapshot(row, gateInput, ctx.product, ctx.now),
    checklist, extraDocuments, issues: [...ctx.issues], createdAt: row.createdAt.toISOString(),
  };
}

/** Жагсаалт, мониторингод харуулах богино нэр. Хувийн мэдээлэл (өмчлөгч) орохгүй; автомашины улсын дугаар ажилтны хариуд л гарна. */
export function describeCollateral(assetType: AssetType, d: Record<string, unknown>): string {
  const s = (k: string): string => (typeof d[k] === 'string' ? (d[k] as string) : '');
  const addr = (d.address && typeof d.address === 'object' ? d.address : {}) as Record<string, unknown>;
  const place = [addr.district, addr.khoroo].filter((x): x is string => typeof x === 'string' && !!x).join(', ');
  switch (assetType) {
    case 'VEHICLE': return [`${s('make')} ${s('model')}`.trim(), typeof d.manufactureYear === 'number' ? String(d.manufactureYear) : '', s('plateNo')].filter(Boolean).join(' · ');
    case 'APARTMENT': return `Орон сууц · ${place} · ${d.areaM2 ?? '?'} м²`;
    case 'HOUSE': return `Байшин · ${place} · ${d.areaM2 ?? '?'} м²`;
    case 'LAND': return `Газар · ${place} · ${d.areaM2 ?? '?'} м²`;
    case 'LIVESTOCK': return `Мал · ${s('livestockType')} · ${d.headCount ?? '?'} толгой`;
    case 'INVENTORY': return `Бараа материал · ${s('name')}`;
    case 'EQUIPMENT': return `Тоног төхөөрөмж · ${s('name')}`;
    case 'OTHER': return `Бусад · ${s('name')}`;
  }
}
