import { Controller, ForbiddenException, Get, Req } from '@nestjs/common';
import { UserRole, type OrgDirectory, type SessionUser } from '@los/contracts';
import { Roles } from '@los/nest-common';
import { DirectoryService } from './directory.service';

type Req_ = { user?: SessionUser };

/**
 * `GET /api/directory` — FR-1.2 (M2). Нэвтэрсэн ЯМАР Ч ажилтны дүр уншина (`@Roles` = бүх UserRole): жагсаалтыг үзэх бүх хэрэглэгчид салбар,
 * ЗЭЗ-ийн нэр хэрэгтэй. Зөвхөн дуудагчийн байгууллагын id → нэр; унших-зөвхөн (бичих route байхгүй).
 */
@Controller('directory')
export class DirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  @Get()
  @Roles(...UserRole)
  get(@Req() req: Req_): Promise<OrgDirectory> {
    const user = req.user;
    if (!user) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Энэ үйлдэлд эрх хүрэхгүй' });
    return this.directory.get(user.orgId);
  }
}
