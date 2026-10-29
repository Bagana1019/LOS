'use client';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { mnDateKey } from '../../lib/format';
import { getProfile, merchantKeys } from '../../lib/merchant-api';
import { watchMnDateKey } from '../../lib/mn-clock';

/** Утга тогтворжсоны дараа л өөрчлөгдөнө (амьд quote-д). */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Зөвхөн компонентын төлөвт байх хайлтын талбар (URL-д БИЧИХГҮЙ). Хайлт нь бүтэн регистр/утасны цифр агуулж болох тул (POS-BR-7) хөтчийн түүх, access log-д үлдэхгүй.
 * `input` — талбарын утга; `value` — бичихээ больсоноос delayMs хойш (хоосон бол тэр даруй) шинэчлэгдэх, API-д дамжуулах утга.
 */
export function useSearchState(delayMs = 400) {
  const [input, setInput] = useState('');
  const [value, setValue] = useState('');
  useEffect(() => {
    const next = input.trim();
    if (next === value) return undefined;
    if (next === '') {
      setValue('');
      return undefined;
    }
    const id = setTimeout(() => setValue(next), delayMs);
    return () => clearTimeout(id);
  }, [input, value, delayMs]);
  /** Талбар ба идэвхтэй хайлтыг нэг дор цэвэрлэнэ. */
  const clear = useCallback(() => {
    setInput('');
    setValue('');
  }, []);
  return { input, setInput, value, clear };
}

/**
 * URL-тай синк хийгдсэн хайлтын талбар (мерчантын жагсаалт: код/нэр — PII биш). Лизингийн хайлтад ХЭРЭГЛЭХГҮЙ — `useSearchState`.
 * Бичих явцад локал утга, delayMs-ийн дараа `commit`-оор URL руу бичнэ.
 * Router-ийн шилжилт хоцорч (urlValue удаан шинэчлэгдэж) байсан ч хуучин утгаар
 * URL-ийг дарж бичихгүй, "цэвэрлэх" дарсан утгыг буцааж оруулахгүйн тулд
 * сүүлд URL-д бичсэн/URL-аас авсан утгыг ref-д хадгална.
 */
export function useUrlSearchInput(urlValue: string, commit: (q: string) => void, delayMs = 400) {
  const [input, setInput] = useState(urlValue);
  const debounced = useDebouncedValue(input.trim(), delayMs);
  const synced = useRef(urlValue);
  // URL гаднаас (өмнөх/дараах товч, холбоос) өөрчлөгдсөн бол талбарыг дагана.
  useEffect(() => {
    if (urlValue !== synced.current) {
      synced.current = urlValue;
      setInput(urlValue);
    }
  }, [urlValue]);
  useEffect(() => {
    if (debounced !== synced.current) {
      synced.current = debounced;
      commit(debounced);
    }
    // Зөвхөн тогтворжсон утга өөрчлөгдөхөд ажиллана (commit-ийн хувилбараас хамаарахгүй).
  }, [debounced]);
  /** Талбарыг цэвэрлэнэ; URL-ийг дуудагч өөрөө цэвэрлэнэ (хоёр удаа бичихгүй). */
  const clear = useCallback(() => {
    synced.current = '';
    setInput('');
  }, []);
  return { input, setInput, clear };
}

/** Улаанбаатарын өнөөдрийн огноо 'YYYY-MM-DD'; шөнө дунд өнгөрөхөд өөрөө шинэчлэгдэнэ (нээлттэй дэлгэц өдөр дамжихад "өнөөдөр" гацахгүй). */
export function useMnDateKey(): string {
  const [key, setKey] = useState(() => mnDateKey(new Date()));
  useEffect(() => {
    setKey(mnDateKey(new Date()));
    return watchMnDateKey(setKey);
  }, []);
  return key;
}

/** Зорилтот агшин хүртэл үлдсэн секунд (дээш бөөрөнхийлнө). null → тоологчгүй. 0 → дууссан. */
export function useCountdown(targetIso: string | null | undefined): number | null {
  const compute = useCallback(() => {
    if (!targetIso) return null;
    const ms = new Date(targetIso).getTime() - Date.now();
    return Number.isNaN(ms) ? null : Math.max(0, Math.ceil(ms / 1000));
  }, [targetIso]);
  const [left, setLeft] = useState<number | null>(compute);
  useEffect(() => {
    setLeft(compute());
    if (!targetIso) return undefined;
    const id = setInterval(() => setLeft(compute()), 1000);
    return () => clearInterval(id);
  }, [compute, targetIso]);
  return left;
}

const MOBILE_QUERY = '(max-width: 767px)';
function subscribeMobile(cb: () => void): () => void {
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
}
/** <768px (утас). Клиент-only render-тэй тул SSR зөрүү үүсэхгүй. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribeMobile, () => window.matchMedia(MOBILE_QUERY).matches, () => false);
}

/** Элементийн өргөн (SVG график бодит пикселээр зурагдахад). */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number') setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** GET /merchant-portal/me — shell, хөтөлбөр, дэлгүүрийн сонголт бүгд ашиглана. */
export function useMe() {
  return useQuery({ queryKey: merchantKeys.me(), queryFn: ({ signal }) => getProfile({ signal }), staleTime: 5 * 60_000 });
}
