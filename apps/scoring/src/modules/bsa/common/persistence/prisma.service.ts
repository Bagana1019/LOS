// scoring сервисийн PrismaClient (apps/scoring/prisma/schema.prisma → node_modules/.prisma/client-scoring).
// Лог: зөвхөн warn — `query` лог ХЭЗЭЭ Ч идэвхжүүлэхгүй (параметрт PII/шифр текст орно, CLAUDE.md §6.5); errorFormat 'minimal' нь алдааны
// мессежид код/аргумент хэвлэхгүй. Домэйн алдаа болгон хөрвүүлдэг (давхар файл…) алдаа Prisma-ийн лог-д давхар бичигдэхгүй.
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
// Generated client-ийг харьцангуй замаар импортлоно: '.prisma/client-scoring' нь tsc/Node-д шийдэгддэг ч Vite (vitest) '.'-ээр эхэлсэн
// нэрийг харьцангуй зам гэж ойлгож чадахгүй. src/ ба dist/ ижил гүнтэй тул зам хоёуланд хүчинтэй.
import { PrismaClient } from '../../../../../node_modules/.prisma/client-scoring';

export { Prisma, PrismaClient } from '../../../../../node_modules/.prisma/client-scoring';
export type {
  BsaAnalysis as BsaAnalysisRow,
  BsaAnalysisEvent as BsaAnalysisEventRow,
  BsaCategory as BsaCategoryRow,
  BsaImportJob as BsaImportJobRow,
  BsaRule as BsaRuleRow,
  BsaTransaction as BsaTransactionRow,
} from '../../../../../node_modules/.prisma/client-scoring';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ log: ['warn'], errorFormat: 'minimal' });
  }
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
