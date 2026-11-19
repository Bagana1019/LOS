import { BadRequestException, Controller, Get, HttpException, HttpStatus, Req, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { CTX_HEADERS, type OrgDirectory } from '@los/contracts';
import { Public } from '@los/nest-common';
import { DirectoryService } from './directory.service';

type Req_ = { headers: Record<string, string | string[] | undefined> };

/** Урт нь ялгаатай токенд ч timingSafeEqual шидэхгүй, урт нь алдагдахгүй (хоёуланг нь sha256-аар ижил урттай болгоно). */
function safeEqual(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * `GET /api/internal/directory` — origination-ийн Excel/CSV экспортод салбар, ЗЭЗ-ийн UUID-г нэр болгох дотоод лавлах (FR-1.2, M2 follow-up).
 * `/api/directory` нь ажилтны JWT-тэй, proxy `Authorization`-ийг тайлдаг тул service-to-service дуудлагад хүрэхгүй. Тиймээс тусдаа, нарийн замтай:
 * JWT guard-аас гарсан (`@Public`) боловч ЗӨВХӨН `X-Internal-Token` (= INTERNAL_AUTH_SECRET) таарсан дуудлагыг хүлээнэ. Токен тохируулаагүй бол ХААЛТТАЙ (503) —
 * энэ нь gateway-ийн нийтийн порт дээр байдаг тул токенгүй хүн байгууллагын нэр уншиж болохгүй. Байгууллага = `X-Org-Id` (origination-ийн баталгаажсан контекст).
 * Зөвхөн id → нэр (`DirectoryService`-тэй ижил, PII-гүй); унших-зөвхөн.
 */
@Controller('internal/directory')
export class InternalDirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  @Get()
  @Public()
  get(@Req() req: Req_): Promise<OrgDirectory> {
    const secret = process.env.INTERNAL_AUTH_SECRET;
    if (!secret) throw new HttpException({ code: 'INTERNAL_AUTH_NOT_CONFIGURED', message: 'Дотоод лавлах тохируулагдаагүй байна' }, HttpStatus.SERVICE_UNAVAILABLE);
    const token = req.headers[CTX_HEADERS.internalToken];
    if (typeof token !== 'string' || !safeEqual(token, secret)) throw new UnauthorizedException({ code: 'INVALID_INTERNAL_TOKEN', message: 'Дотоод сервисийн токен буруу' });
    const org = req.headers[CTX_HEADERS.orgId];
    const orgId = typeof org === 'string' ? org.trim() : '';
    if (!orgId) throw new BadRequestException({ code: 'MISSING_ORG', message: 'X-Org-Id толгой дутуу' });
    return this.directory.get(orgId);
  }
}
