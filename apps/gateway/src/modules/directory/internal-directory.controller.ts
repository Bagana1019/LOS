import { BadRequestException, Controller, Get, HttpException, HttpStatus, Req, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { CTX_HEADERS, DIRECTORY_TOKEN_HEADER, type OrgDirectory } from '@los/contracts';
import { Public } from '@los/nest-common';
import { DirectoryService } from './directory.service';
import { configuredDirectoryToken } from './directory-token';

type Req_ = { headers: Record<string, string | string[] | undefined> };

/** Байгууллагын id (UUID / cuid): үсэг, тоо, `-`, `_`, ≤64. Бусад хэлбэр (зай, зам, тусгай тэмдэгт) нь DB хүртэл хүрэхгүй. */
const ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Урт нь ялгаатай токенд ч timingSafeEqual шидэхгүй, урт нь алдагдахгүй (хоёуланг нь sha256-аар ижил урттай болгоно). */
function safeEqual(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * `GET /api/internal/directory` — origination-ийн Excel/CSV экспортод салбар, ЗЭЗ-ийн UUID-г нэр болгох дотоод лавлах (FR-1.2, M2 follow-up).
 * `/api/directory` нь ажилтны JWT-тэй, proxy `Authorization`-ийг тайлдаг тул service-to-service дуудлагад хүрэхгүй. Тиймээс тусдаа, нарийн замтай:
 * JWT guard-аас гарсан (`@Public`) боловч ЗӨВХӨН бие даасан `X-Directory-Token` (= GATEWAY_DIRECTORY_TOKEN) таарсан дуудлагыг хүлээнэ.
 * `INTERNAL_AUTH_SECRET` энд ХЭЗЭЭ Ч хүчинтэй биш: gateway proxy үүнийг бүх backend-д тарааж өгдөг тул аль нэг backend-ийн эвдрэл лавлахыг нээж болохгүй.
 * Токен тохируулаагүй бол ХААЛТТАЙ (503). Байгууллага = `X-Org-Id` (хатуу хэлбэр, буруу бол 400). Зөвхөн id → нэр (PII-гүй); унших-зөвхөн.
 * Зам нь ЗӨВХӨН энэ controller-оор үйлчлэгдэнэ: `internal` нь PROXIED_SERVICES-д ороогүй тул `/api/internal/*` хэзээ ч backend рүү дамжихгүй.
 * Ingress нь `/api/internal/*`-ийг нийтийн сүлжээнээс хаах ёстой (docs/DECISIONS.md, 2026-11-19 · 4-р үе шат).
 */
@Controller('internal/directory')
export class InternalDirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  @Get()
  @Public()
  get(@Req() req: Req_): Promise<OrgDirectory> {
    const secret = configuredDirectoryToken();
    if (!secret) throw new HttpException({ code: 'DIRECTORY_TOKEN_NOT_CONFIGURED', message: 'Дотоод лавлах тохируулагдаагүй байна' }, HttpStatus.SERVICE_UNAVAILABLE);
    const token = req.headers[DIRECTORY_TOKEN_HEADER];
    if (typeof token !== 'string' || !safeEqual(token, secret)) throw new UnauthorizedException({ code: 'INVALID_DIRECTORY_TOKEN', message: 'Лавлахын токен буруу' });
    const org = req.headers[CTX_HEADERS.orgId];
    if (typeof org !== 'string' || !ORG_ID.test(org)) throw new BadRequestException({ code: 'INVALID_ORG', message: 'X-Org-Id толгой дутуу эсвэл буруу' });
    return this.directory.get(org);
  }
}
