import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { LoanApplication } from '.prisma/client-origination';
import { PrismaService } from '../prisma.service';
import type { RequestContext } from '@los/contracts';
import { hasRole } from './roles';

/**
 * NFR-3 / docs/01 §3: ЗЭЗ зөвхөн өөрийн хариуцсан хүсэлт; салбарын захирал өөрийн салбар (унших); батлагч/админ бүгд (унших).
 * Бичих эрх: ЗЭЗ (өөрийн хүсэлт) ба ADMIN. CUSTOMER дүр (self-service BFF) зөвхөн өөрийн хүсэлтийн үндсэн/хамтран зээлдэгчээр.
 */
@Injectable()
export class ApplicationAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async load(ctx: RequestContext, applicationId: string, mode: 'read' | 'write' | 'pay'): Promise<LoanApplication> {
    const app = await this.prisma.loanApplication.findFirst({ where: { id: applicationId, orgId: ctx.orgId } });
    if (!app) throw new NotFoundException({ code: 'APPLICATION_NOT_FOUND', message: 'Хүсэлт олдсонгүй' });
    if (!(await this.can(ctx, app, mode))) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Энэ хүсэлтэд хандах эрхгүй' });
    return app;
  }

  async can(ctx: RequestContext, app: Pick<LoanApplication, 'id' | 'branchId' | 'officerId'>, mode: 'read' | 'write' | 'pay'): Promise<boolean> {
    if (hasRole(ctx, 'ADMIN')) return true;
    if (hasRole(ctx, 'OFFICER') && ctx.userId && app.officerId === ctx.userId) return true;
    if (mode !== 'write') {
      if (hasRole(ctx, 'APPROVER') && mode === 'read') return true;
      if (hasRole(ctx, 'BRANCH_MANAGER') && ctx.branchId && app.branchId === ctx.branchId) return true;
    }
    if (hasRole(ctx, 'CUSTOMER') && ctx.customerId && mode !== 'write') {
      const link = await this.prisma.loanApplicationBorrower.findFirst({ where: { applicationId: app.id, customerId: ctx.customerId, role: { in: ['PRIMARY', 'CO_BORROWER'] } }, select: { id: true } });
      return !!link;
    }
    return false;
  }
}
