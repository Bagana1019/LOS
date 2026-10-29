// Бүх дуудлага gateway руу. Сервис рүү шууд дуудахгүй (CLAUDE.md §3).
export const API = process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://localhost:4000/api';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string, readonly issues?: Array<{ path: string; message: string }>) {
    super(message);
  }
}

// Gateway ажиллаагүй local dev-д: NEXT_PUBLIC_DEV_HEADERS='{"x-user-id":"officer-1","x-roles":"OFFICER"}' гэж сервис рүү шууд заахад ашиглана.
// Үйлдвэрлэлд gateway JWT-ээс эдгээр толгойг өөрөө тавина.
function devHeaders(): Record<string, string> {
  if (process.env.NODE_ENV === 'production') return {};
  try { return JSON.parse(process.env.NEXT_PUBLIC_DEV_HEADERS ?? '{}'); } catch { return {}; }
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export async function apiFetch<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: { Accept: 'application/json', ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...devHeaders(), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: 'include',
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Module 0 AllExceptionsFilter: zod алдаа = { code: 'VALIDATION_FAILED', details: [{ path, message }] }
    const issues = body?.code === 'VALIDATION_FAILED' && Array.isArray(body.details) ? body.details : body?.issues;
    throw new ApiError(res.status, body?.code ?? null, body?.message ?? res.statusText, issues);
  }
  return body as T;
}

/** Файл (Excel) татах — gateway-н дамжуулсан Blob-ыг хөтөч дээр хадгалуулна. */
export async function apiDownload(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`${API}${path}`, { headers: devHeaders(), credentials: 'include' });
  if (!res.ok) throw new ApiError(res.status, null, res.statusText);
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd)?.[1];
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name ? decodeURIComponent(name) : fallbackName });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
