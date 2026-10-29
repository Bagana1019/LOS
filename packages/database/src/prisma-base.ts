// Сервис бүр өөрийн PrismaClient-тэй (apps/<svc>/prisma/schema.prisma, datasource schema = <svc>).
// Энд зөвхөн нийтлэг: аудит хийх модель, шифрлэлт (./crypto), outbox (./outbox), audit (./audit).
export const AUDIT_MODELS = ['LoanApplication', 'ApprovalVote', 'Collateral', 'BsaTransaction', 'BsaSuspicion', 'DisbursementRequest'];
