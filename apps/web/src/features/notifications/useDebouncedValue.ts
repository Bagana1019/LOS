import { useEffect, useState } from 'react';

/** `value` тогтворжсоны дараа `delayMs` өнгөрвөл шинэчлэгдэнэ (урьдчилан харах хүсэлтийг бичих бүрд илгээхгүйн тулд). */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
