// Seed-ийн тогтмол ID (сервис бүрийн seed ижил org/салбар/хэрэглэгчийг иш татна — cross-schema FK-гүй тул string ID).
export const SEED = {
  org: { id: '00000000-0000-4000-8000-000000000001', code: 'LOS', name: 'LOS Radix ББСБ' },
  branches: {
    head: { id: '00000000-0000-4000-8000-000000000101', code: '100', name: 'Төв салбар' },
    bayanzurkh: { id: '00000000-0000-4000-8000-000000000102', code: '200', name: 'Баянзүрх салбар' },
  },
  users: {
    officerA: { id: '00000000-0000-4000-8000-000000000201', username: 'officer.a', fullName: 'ЗЭЗ А', roles: ['OFFICER'] as const, branch: 'head' as const },
    officerB: { id: '00000000-0000-4000-8000-000000000202', username: 'officer.b', fullName: 'ЗЭЗ Б', roles: ['OFFICER'] as const, branch: 'bayanzurkh' as const },
    manager: { id: '00000000-0000-4000-8000-000000000203', username: 'manager', fullName: 'Салбарын захирал', roles: ['BRANCH_MANAGER'] as const, branch: 'head' as const },
    approver: { id: '00000000-0000-4000-8000-000000000204', username: 'approver', fullName: 'Батлагч', roles: ['APPROVER'] as const, branch: 'head' as const },
    admin: { id: '00000000-0000-4000-8000-000000000205', username: 'admin', fullName: 'Админ', roles: ['ADMIN'] as const, branch: null },
  },
} as const;
