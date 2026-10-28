/** 99112233 → 99****33 */
export function maskPhone(phone: string): string {
  if (phone.length < 6) return '*'.repeat(phone.length);
  return `${phone.slice(0, 2)}${'*'.repeat(phone.length - 4)}${phone.slice(-2)}`;
}
