// PRT-NFR-3 / docs/05 §6: харилцагч руу (portal-bff-ээр) регистр, бүтэн нэр, бүтэн утас гарахгүй.

/** «Батболд Болд» → «Б. Болд». */
export function displayName(c: { lastName: string | null; firstName: string }): string {
  const last = c.lastName?.trim();
  const firstName = c.firstName.trim();
  return last ? `${[...last][0].toUpperCase()}. ${firstName}` : firstName;
}

/** «+976 9911-2233» → «99****33». Зөвхөн цифрүүдээс (улсын код хасна). */
export function maskPhone(raw: string | null | undefined): string {
  if (!raw) return '';
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('976')) digits = digits.slice(3);
  if (digits.length < 6) return '*'.repeat(digits.length);
  return `${digits.slice(0, 2)}${'*'.repeat(digits.length - 4)}${digits.slice(-2)}`;
}
