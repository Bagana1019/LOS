// PII далдлах туслахууд (хариуны объектод): регистр, данс, утас. Бүтнээр нь лог/event/issue-д бичихгүй; харагдац (view)-д л далдлагдсан хэлбэр гарна.
export function maskTail(value: string | null | undefined, keep = 4): string | null {
  if (value === null || value === undefined || value === '') return null;
  const v = value.trim();
  if (v.length <= keep) return '*'.repeat(v.length);
  return `${'*'.repeat(Math.min(v.length - keep, 8))}${v.slice(-keep)}`;
}
