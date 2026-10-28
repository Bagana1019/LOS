import { AuthResponse, type LoginRequest } from '@los/contracts';
import { ApiError, readError, send } from '../http';

// Access token зөвхөн санах ойд (XSS-ийн нөлөөг багасгана). Refresh token нь gateway-н httpOnly cookie `los_rt`,
// JS-д харагдахгүй; хуудас дахин ачаалахад `/auth/refresh`-ээр сэргээнэ (DECISIONS.md: M0 · gateway нэвтрэлт).
let accessToken: string | null = null;
let refreshInFlight: Promise<AuthResponse | null> | null = null;
const endedListeners = new Set<() => void>();

export const getAccessToken = () => accessToken;

/** Сесс дундаа дууссан (refresh амжилтгүй) үед сонсоно. */
export function onSessionEnded(fn: () => void): () => void {
  endedListeners.add(fn);
  return () => {
    endedListeners.delete(fn);
  };
}
export function endSession(): void {
  accessToken = null;
  endedListeners.forEach((fn) => fn());
}

async function readAuth(res: Response): Promise<AuthResponse> {
  const s = AuthResponse.parse(await res.json());
  accessToken = s.accessToken;
  return s;
}

export async function loginRequest(body: LoginRequest): Promise<AuthResponse> {
  const { res, correlationId } = await send('/auth/login', { method: 'POST', body });
  if (!res.ok) throw await readError(res, correlationId);
  return readAuth(res);
}

async function doRefresh(): Promise<AuthResponse | null> {
  const { res, correlationId } = await send('/auth/refresh', { method: 'POST' });
  if (res.status === 401) {
    accessToken = null;
    return null;
  }
  if (!res.ok) throw await readError(res, correlationId);
  return readAuth(res);
}

/** Refresh token эргэлддэг тул (ашигласан token дахин ирвэл бүх гинж хүчингүй) зэрэг дуудлагыг нэгтгэнэ:
 *  нэг табын дотор нэг promise, олон таб хооронд Web Locks. */
export function refreshSession(): Promise<AuthResponse | null> {
  if (!refreshInFlight) {
    const run = typeof navigator !== 'undefined' && navigator.locks ? Promise.resolve(navigator.locks.request('los-auth-refresh', doRefresh)) : doRefresh();
    refreshInFlight = run.finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Серверийн сесс хүчингүй болсон (2xx эсвэл 401) үед л орон нутгийн төлөвийг цэвэрлэнэ; сүлжээ/5xx бол алдаа шиднэ,
 *  учир нь cookie амьд үлдвэл дараагийн ачаалалтаар буцаж нэвтэрнэ. */
export async function logoutRequest(): Promise<void> {
  const { res, correlationId } = await send('/auth/logout', { method: 'POST', token: accessToken });
  if (!res.ok && res.status !== 401) throw await readError(res, correlationId);
  accessToken = null;
}

export { ApiError };
