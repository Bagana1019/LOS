import { AuthResponse, type LoginRequest } from '@los/contracts';
import { ApiError, readError, send } from '../http';

// NFR-3 / M0 нэвтрэлт. Access token зөвхөн санах ойд (XSS-ийн нөлөөг багасгана). Refresh token нь gateway-н httpOnly
// cookie `los_rt`, JS-д харагдахгүй; хуудас дахин ачаалахад `/auth/refresh`-ээр сэргээнэ (DECISIONS.md: M0 · gateway нэвтрэлт).
let accessToken: string | null = null;
let refreshInFlight: Promise<AuthResponse | null> | null = null;
const endedListeners = new Set<() => void>();
const refreshedListeners = new Set<(s: AuthResponse) => void>();

export const getAccessToken = () => accessToken;

const subscribe = <F>(set: Set<F>, fn: F): (() => void) => {
  set.add(fn);
  return () => {
    set.delete(fn);
  };
};
/** Сесс дундаа дууссан (refresh амжилтгүй) үед сонсоно. */
export const onSessionEnded = (fn: () => void) => subscribe(endedListeners, fn);
/** Refresh бүрийн хариу (хэрэглэгч, эрх, цэс). Cookie браузер даяар нэг тул өөр табд хэрэглэгч солигдсон байж болно. */
export const onSessionRefreshed = (fn: (s: AuthResponse) => void) => subscribe(refreshedListeners, fn);

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
  const s = await readAuth(res);
  refreshedListeners.forEach((fn) => fn(s));
  return s;
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
 *  учир нь cookie амьд үлдвэл дараагийн ачаалалтаар буцаж нэвтэрнэ. Явж буй refresh-ийг эхлээд хүлээнэ — эс бөгөөс
 *  түүний хариу logout-ын дараа шинэ token/cookie тавьж сессийг сэргээнэ. */
export async function logoutRequest(): Promise<void> {
  await refreshInFlight?.catch(() => undefined);
  const { res, correlationId } = await send('/auth/logout', { method: 'POST', token: accessToken });
  if (!res.ok && res.status !== 401) throw await readError(res, correlationId);
  accessToken = null;
}

export { ApiError };
