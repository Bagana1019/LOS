// Tiny pure helpers for showing people/branches by name instead of by UUID (F8-3).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID.test(value);

/** Own-property + non-blank name; inherited keys (`constructor`, `__proto__`) never resolve. Null = not resolvable. */
export function resolveName(map: Readonly<Record<string, string>> | undefined, id: string): string | null {
  if (!map || !Object.hasOwn(map, id)) return null;
  const name = map[id]?.trim();
  return name ? name : null;
}
