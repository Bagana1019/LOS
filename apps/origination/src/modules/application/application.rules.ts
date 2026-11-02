import { STAGE1_STEPS, STAGE2_STEPS, type ApplicationStatus, type StepKey, type StepStatus } from '@los/contracts';

// Модуль 2 — хүсэлтийн төлвийн машин (docs/01 §4), цэвэр функцүүд (I/O байхгүй).

/** Зөвшөөрөгдсөн шилжилт. MIGRATED нь зөвхөн импортоор орно — шилжилтгүй. */
export const TRANSITIONS: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['IN_APPROVAL'],
  IN_APPROVAL: ['APPROVED', 'RETURNED'],
  RETURNED: ['SUBMITTED'],
  APPROVED: ['DISBURSING'],
  DISBURSING: ['ACTIVE', 'APPROVED'],
  ACTIVE: ['CLOSED'],
  CLOSED: [],
  MIGRATED: [],
};

/** docs/01 §4 "Хэн шилжүүлнэ": ЗЭЗ-ийн (хэрэглэгчийн) шилжилт. Бусад нь систем / батлагч / Core — өөр модуль `StateMachine.apply`-аар. */
export const USER_TRANSITIONS: ReadonlySet<string> = new Set(['DRAFT>SUBMITTED', 'RETURNED>SUBMITTED', 'APPROVED>DISBURSING']);
/** HTTP-ээр шууд дуудаж болох шилжилт (APPROVED>DISBURSING нь Модуль 11-ийн олголтын хүсэлтээр). */
export const HTTP_TRANSITIONS: ReadonlySet<string> = new Set(['DRAFT>SUBMITTED', 'RETURNED>SUBMITTED']);

export const canTransition = (from: ApplicationStatus, to: ApplicationStatus): boolean => TRANSITIONS[from].includes(to);
export const isUserTransition = (from: ApplicationStatus, to: ApplicationStatus): boolean => USER_TRANSITIONS.has(`${from}>${to}`);
export const isHttpTransition = (from: ApplicationStatus, to: ApplicationStatus): boolean => HTTP_TRANSITIONS.has(`${from}>${to}`);

/** Хүсэлтийг ЗЭЗ засах боломжтой төлөв. */
export const EDITABLE_STATUSES: readonly ApplicationStatus[] = ['DRAFT', 'RETURNED'];
export const isEditable = (status: string): boolean => (EDITABLE_STATUSES as readonly string[]).includes(status);

/** Төлөв шилжихэд тавигдах огнооны талбар. */
export const TIMESTAMP_FIELD: Partial<Record<ApplicationStatus, 'submittedAt' | 'approvedAt' | 'returnedAt' | 'disbursedAt'>> = {
  SUBMITTED: 'submittedAt', APPROVED: 'approvedAt', RETURNED: 'returnedAt', ACTIVE: 'disbursedAt',
};

export const STEP_ORDER: readonly StepKey[] = [...STAGE1_STEPS, ...STAGE2_STEPS];
export const stageOf = (key: StepKey): 1 | 2 => ((STAGE2_STEPS as readonly string[]).includes(key) ? 2 : 1);

/** Шинэ хүсэлт: 1-р үе шат PENDING, 2-р үе шат (гэрээ, албан бичиг, олголт) APPROVED хүртэл LOCKED. */
export const initialStepStatus = (key: StepKey): StepStatus => (stageOf(key) === 1 ? 'PENDING' : 'LOCKED');

export interface StepLike { stepKey: string; status: string }

/** G1 (BR-7): заавал алхмуудаас бүрдээгүй (COMPLETED биш) нь. */
export function missingRequiredSteps(steps: readonly StepLike[], required: readonly string[]): StepKey[] {
  const done = new Set(steps.filter((s) => s.status === 'COMPLETED').map((s) => s.stepKey));
  return STEP_ORDER.filter((k) => required.includes(k) && !done.has(k));
}

/** Wizard-ийн 1-р үе шатны тоолуур: бүрдсэн / нийт. */
export function stage1Progress(steps: readonly StepLike[]): { completed: number; total: number } {
  const s1 = steps.filter((s) => stageOf(s.stepKey as StepKey) === 1);
  return { completed: s1.filter((s) => s.status === 'COMPLETED').length, total: STAGE1_STEPS.length };
}

/** APPROVED болоход 2-р үе шат нээгдэнэ (G3): LOCKED → PENDING. */
export const unlocksStage2 = (to: ApplicationStatus): boolean => to === 'APPROVED';

/** Хүсэлтийн дугаар: `LA-<он>-<6 оронтой дараалал>`. */
export const formatAppNo = (year: number, seq: number): string => `LA-${year}-${String(seq).padStart(6, '0')}`;
