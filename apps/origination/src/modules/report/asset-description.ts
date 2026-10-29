// Барьцааны `description_json` (docs/03: plate, make, model, year | address, area_m2, floor, certificate_no | head_count…) → нэг мөр тодорхойлолт.
const text = (o: Record<string, unknown>, key: string): string => {
  const v = o[key];
  return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
};

export function describeAsset(assetType: string, description: unknown): string | null {
  if (!description || typeof description !== 'object' || Array.isArray(description)) return null;
  const o = description as Record<string, unknown>;
  let parts: string[];
  switch (assetType) {
    case 'VEHICLE':
      parts = [text(o, 'plate'), text(o, 'make'), text(o, 'model'), text(o, 'year')];
      break;
    case 'APARTMENT':
    case 'HOUSE':
    case 'LAND': {
      const area = text(o, 'area_m2');
      const floor = text(o, 'floor');
      const cert = text(o, 'certificate_no');
      parts = [text(o, 'address'), area && `${area} м²`, floor && `${floor}-р давхар`, cert && `Гэрчилгээ ${cert}`];
      break;
    }
    case 'LIVESTOCK': {
      const heads = text(o, 'head_count');
      parts = [text(o, 'livestock_type') || text(o, 'type'), heads && `${heads} толгой`];
      break;
    }
    default:
      parts = [text(o, 'description') || text(o, 'name')];
  }
  const s = parts.filter(Boolean).join(' ');
  return s ? s.slice(0, 200) : null;
}
