import { MIN_INTERNAL_AUTH_SECRET_LENGTH, isPlaceholderSecret, isProduction } from '@los/nest-common';

type Env = Record<string, string | undefined>;

/**
 * `GET /api/internal/directory`-ийн БИЕ ДААСАН нууц. `INTERNAL_AUTH_SECRET`-ийг gateway proxy бүх backend-д тарааж өгдөг тул
 * (аль нэг backend эвдрэхэд лавлах нээгдэхгүйн тулд) энэ замд ашиглахгүй. Production-д `assertInternalAuthSecret`-тэй ижил дүрэм
 * (≥16 тэмдэгт, .env.example-ийн загвар биш) + INTERNAL_AUTH_SECRET-тэй ЗӨРҮҮТЭЙ байх.
 */
const problemInProduction = (token: string, env: Env): string | null => {
  if (token.length < MIN_INTERNAL_AUTH_SECRET_LENGTH) return `GATEWAY_DIRECTORY_TOKEN must be at least ${MIN_INTERNAL_AUTH_SECRET_LENGTH} characters in production. Refusing to start`;
  if (isPlaceholderSecret(token)) return 'GATEWAY_DIRECTORY_TOKEN is a public placeholder (e.g. the .env.example value) and must be replaced in production. Refusing to start';
  if (token === (env.INTERNAL_AUTH_SECRET?.trim() ?? '')) return 'GATEWAY_DIRECTORY_TOKEN must differ from INTERNAL_AUTH_SECRET: the proxy hands INTERNAL_AUTH_SECRET to every backend. Refusing to start';
  return null;
};

/** Хүсэлт бүрт: хүчинтэй токен, эс бөгөөс null (→ 503, хаалттай). Production-д сул утга тохируулаагүйтэй адил (bootstrap-ээс гадна давхар хамгаалалт). */
export function configuredDirectoryToken(env: Env = process.env): string | null {
  const token = env.GATEWAY_DIRECTORY_TOKEN?.trim() ?? '';
  if (!token) return null;
  return isProduction(env) && problemInProduction(token, env) ? null : token;
}

/**
 * Bootstrap (configureGateway): production-д токен тохируулсан боловч сул бол gateway эхлэхгүй. Тохируулаагүй бол эхлэхийг хориглохгүй —
 * лавлах унтарна (503), origination-ийн экспорт id-тай үргэлжилнэ. Production бус орчинд шалгахгүй.
 */
export function assertDirectoryToken(env: Env = process.env): void {
  const token = env.GATEWAY_DIRECTORY_TOKEN?.trim() ?? '';
  if (!token || !isProduction(env)) return;
  const problem = problemInProduction(token, env);
  if (problem) throw new Error(problem);
}
