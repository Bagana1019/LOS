import { Injectable } from '@nestjs/common';
import type { OrgDirectory } from '@los/contracts';
import { PrismaService } from '../../prisma.service';

/**
 * FR-1.2 (M2): салбар, хэрэглэгчийн id → харуулах нэр. `iam` schema-г эзэмшигч нь gateway тул origination-аас sync дуудахгүй (CLAUDE.md §3.2.2) —
 * web энэ лавлахаар хүсэлтийн жагсаалтын UUID-г нэр болгоно. Зөвхөн дуудагчийн байгууллага; PII (username, email, phone, дүр) уншихгүй.
 * Идэвхгүй болсон салбар/ЗЭЗ орно: хуучин хүсэлт тэдний id-г хадгалсан хэвээр.
 */
@Injectable()
export class DirectoryService {
  constructor(private readonly prisma: PrismaService) {}

  async get(orgId: string): Promise<OrgDirectory> {
    const [branches, users] = await Promise.all([
      this.prisma.branch.findMany({ where: { orgId }, select: { id: true, name: true } }),
      this.prisma.user.findMany({ where: { orgId }, select: { id: true, fullName: true } }),
    ]);
    return {
      branches: Object.fromEntries(branches.map((b) => [b.id, b.name])),
      users: Object.fromEntries(users.map((u) => [u.id, u.fullName])),
    };
  }
}
