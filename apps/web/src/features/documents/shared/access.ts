// docs/05 §3: бичих — OFFICER (өөрийн хүсэлт), ADMIN; унших — BRANCH_MANAGER, APPROVER нэмэгдэнэ. UX-ийн шалгалт: эцсийн эрх, хүрээ, төлвийг origination шалгаад 403/409 өгнө.
const WRITER_ROLES: readonly string[] = ['OFFICER', 'ADMIN'];

export const canWriteApplication = (roles: readonly string[] | undefined): boolean => !!roles?.some((r) => WRITER_ROLES.includes(r));

export interface WriteState {
  /** Дүрээр бичих эрхтэй эсэх. */
  canWrite: boolean;
  /** Хүсэлт "Шинэ"/"Буцаасан" төлөвт (борроуэрсийн жагсаалтын `summary.editable`); тодорхойгүй (ачаалж байна) бол undefined. */
  editable: boolean | undefined;
}

/** DRAFT/RETURNED шаарддаг үйлдлүүд (нэмэх, засах, шалгах, баримт). Төлөв тодорхойгүй бол сервер 409-өөр шийднэ. */
export const canEditContent = (s: WriteState): boolean => s.canWrite && s.editable !== false;
export type DisabledReason = 'role' | 'status' | null;
export const editBlockedReason = (s: WriteState): DisabledReason => (!s.canWrite ? 'role' : s.editable === false ? 'status' : null);
