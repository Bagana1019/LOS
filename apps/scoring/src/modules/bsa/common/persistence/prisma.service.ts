// scoring сервисийн PrismaClient (apps/scoring/prisma/schema.prisma → node_modules/.prisma/client-scoring).
// Лог: зөвхөн warn — `query` лог ХЭЗЭЭ Ч идэвхжүүлэхгүй (параметрт PII/шифр текст орно, CLAUDE.md §6.5); errorFormat 'minimal' нь алдааны
// мессежид код/аргумент хэвлэхгүй. Домэйн алдаа болгон хөрвүүлдэг (давхар файл…) алдаа Prisma-ийн лог-д давхар бичигдэхгүй.
// Generated client-ийг харьцангуй замаар импортлоно (src/ ба dist/ ижил гүнтэй тул зам хоёуланд хүчинтэй).
export { Prisma, PrismaClient } from '../../../../../node_modules/.prisma/client-scoring';
export type {
  BsaAnalysis as BsaAnalysisRow,
  BsaAnalysisEvent as BsaAnalysisEventRow,
  BsaCategory as BsaCategoryRow,
  BsaImportJob as BsaImportJobRow,
  BsaRule as BsaRuleRow,
  BsaTransaction as BsaTransactionRow,
} from '../../../../../node_modules/.prisma/client-scoring';

// Нэг PrismaClient (connection pool): app-ын PrismaService (src/prisma.service.ts, глобал PrismaModule) — BSA өөрийн клиент нээхгүй.
export { PrismaService } from '../../../../prisma.service';
