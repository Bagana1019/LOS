import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

export interface AuditRecord {
  orgId?: string | null; entity: string; entityId: string; action: string; actorId?: string | null;
  afterJson?: unknown; beforeJson?: unknown; correlationId?: string | null; ip?: string | null; userAgent?: string | null;
}

/** iam.audit_log — нэвтрэлт ба gateway-ээр дамжсан өөрчлөлтийн хүсэлт (NFR-4). Нууц үг, token, body хэзээ ч бичихгүй. */
@Injectable()
export class AuditService {
  private readonly log = new Logger('Audit');
  constructor(private readonly prisma: PrismaService) {}

  async record(r: AuditRecord): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        orgId: r.orgId ?? null, entity: r.entity, entityId: r.entityId, action: r.action, actorId: r.actorId ?? null,
        afterJson: (r.afterJson ?? null) as never, beforeJson: (r.beforeJson ?? null) as never,
        correlationId: r.correlationId ?? null, ip: r.ip ?? null, userAgent: r.userAgent?.slice(0, 300) ?? null,
      },
    });
  }

  /** Хүсэлтийн урсгалыг хаахгүй: бичиж чадахгүй бол лог-д алдаа. (Нэвтрэлтийн аудитыг `record`-оор шууд, await-тай бичнэ.) */
  recordSafe(r: AuditRecord): void {
    this.record(r).catch((e: unknown) => this.log.error(`audit write failed: ${e instanceof Error ? e.message : String(e)}`));
  }
}
