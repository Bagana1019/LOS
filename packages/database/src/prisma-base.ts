// Сервис бүр өөрийн PrismaClient-тэй (apps/<svc>/prisma/schema.prisma, datasource schema = <svc>).
// Энд зөвхөн нийтлэг middleware: audit, soft-ban on cross-schema, encryption helper.
export function encryptedField(_plain: string): string { throw new Error('TODO(M00): pgcrypto wrapper (регистр, данс)'); }
export function decryptedField(_cipher: string): string { throw new Error('TODO(M00)'); }
export const AUDIT_MODELS = ['LoanApplication','ApprovalVote','Collateral','BsaTransaction','BsaSuspicion','DisbursementRequest'];
