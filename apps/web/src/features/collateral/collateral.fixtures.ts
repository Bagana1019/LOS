import type {
  BorrowerListResponse, BorrowerView, CollateralChecklistItem, CollateralGate, CollateralListResponse, CollateralMutationResponse, CollateralSummary, CollateralView,
  EncumbranceCheckView, GateIssue, GateIssueCode, OwnershipCheck, ValuationSnapshot,
} from '@los/contracts';

// Тестийн өгөгдлийн жишээ (vitest + Playwright e2e). Зөвхөн `@los/contracts`-ийн төрөл — аппын кодоос импортлогдохгүй.
// Бүх утга зохиомол (DEMO): регистр далдлагдсан, дугаарууд жишээ.

export const IDS = {
  app: '0a1b2c3d-1111-4a11-8a11-000000000001',
  owner: '0a1b2c3d-2222-4a22-8a22-000000000001',
  pledgor: '0a1b2c3d-2222-4a22-8a22-000000000002',
  guarantor: '0a1b2c3d-2222-4a22-8a22-000000000003',
  vehicle: '0a1b2c3d-3333-4a33-8a33-000000000001',
  apartment: '0a1b2c3d-3333-4a33-8a33-000000000002',
  inventory: '0a1b2c3d-3333-4a33-8a33-000000000003',
  newVehicle: '0a1b2c3d-3333-4a33-8a33-0000000000ff',
  file: '0a1b2c3d-4444-4a44-8a44-000000000001',
  file2: '0a1b2c3d-4444-4a44-8a44-000000000002',
  report: '0a1b2c3d-4444-4a44-8a44-0000000000aa',
} as const;

export const NOW = '2026-10-29T03:00:00.000Z';

export const makeIssue = (code: GateIssueCode, collateralId: string | null = null, message = `API: ${code}`): GateIssue => ({ code, collateralId, message });

export const makeGate = (overrides: Partial<CollateralGate> = {}): CollateralGate => ({ complete: false, skipped: false, issues: [], evaluatedAt: NOW, ...overrides });

export const makeSummary = (overrides: Partial<CollateralSummary> = {}): CollateralSummary => ({
  count: 0,
  totalMarketValue: 0,
  totalCollateralValue: 0,
  loanAmount: 10_000_000,
  ltv: null,
  ltvLimit: 0.7,
  ltvPass: null,
  requiresCollateral: true,
  ...overrides,
});

export const makeChecklist = (items: Array<Partial<CollateralChecklistItem> & { key: string }> = []): CollateralChecklistItem[] =>
  items.map((i) => ({ label: i.key, required: true, satisfied: false, documents: [], ...i }));

export const makeOwnership = (overrides: Partial<OwnershipCheck> = {}): OwnershipCheck => ({
  status: 'VERIFIED',
  method: 'REGISTRY',
  source: 'XYP',
  checkedAt: NOW,
  owners: [{ registerMasked: 'УБ****5678', name: 'Бат Болд', matchedCustomerId: IDS.owner, role: 'PRIMARY' }],
  message: null,
  note: null,
  ...overrides,
});

export const makeEncumbrance = (overrides: Partial<EncumbranceCheckView> = {}): EncumbranceCheckView => ({
  status: 'CLEAR',
  method: 'REGISTRY',
  checkedAt: NOW,
  sources: [
    { source: 'ZMS', status: 'CLEAR', pledgee: null, registeredAt: null, note: null },
    { source: 'EB', status: 'CLEAR', pledgee: null, registeredAt: null, note: null },
  ],
  note: null,
  ...overrides,
});

export const makeValuation = (overrides: Partial<ValuationSnapshot> = {}): ValuationSnapshot => ({
  valuationId: '0a1b2c3d-5555-4a55-8a55-000000000001',
  source: 'INTERNAL',
  valuedAt: NOW,
  validUntil: '2027-01-27T03:00:00.000Z',
  expired: false,
  marketValue: 20_000_000,
  haircutRate: 0.7,
  collateralValue: 14_000_000,
  overrideReason: null,
  externalRequired: false,
  externalSatisfied: true,
  ...overrides,
});

export const VEHICLE_DESCRIPTION = { plateNo: '1234УБА', make: 'Toyota', model: 'Prius', manufactureYear: 2012, mileageKm: 150000, fuelType: 'HYBRID' };

export const makeCollateral = (overrides: Partial<CollateralView> = {}): CollateralView => ({
  id: IDS.vehicle,
  applicationId: IDS.app,
  kind: 'MOVABLE',
  assetType: 'VEHICLE',
  description: { ...VEHICLE_DESCRIPTION },
  source: 'MANUAL',
  owner: { customerId: IDS.owner, displayName: 'Бат Болд', role: 'PRIMARY' },
  registryNo: null,
  registryDate: null,
  insuranceExpiresAt: null,
  nextRevaluationAt: null,
  releasedAt: null,
  note: null,
  ownership: null,
  encumbrance: null,
  valuation: null,
  checklist: makeChecklist([{ key: 'vehicle_certificate', label: 'Тээврийн хэрэгслийн гэрчилгээ' }, { key: 'insurance', label: 'Даатгалын гэрээ', required: false }]),
  extraDocuments: [],
  issues: [],
  createdAt: NOW,
  ...overrides,
});

export const makeApartment = (overrides: Partial<CollateralView> = {}): CollateralView =>
  makeCollateral({
    id: IDS.apartment,
    kind: 'IMMOVABLE',
    assetType: 'APARTMENT',
    description: { propertyId: 'Ү-2201001234', address: { province: 'Улаанбаатар', district: 'Хан-Уул', khoroo: '11-р хороо', detail: '15-р байр 43 тоот' }, areaM2: 56.5, floor: 4, purpose: 'RESIDENTIAL' },
    ...overrides,
  });

export const makeInventory = (overrides: Partial<CollateralView> = {}): CollateralView =>
  makeCollateral({
    id: IDS.inventory,
    assetType: 'INVENTORY',
    description: { name: 'Хүнсний бараа', stocktakeValue: 8_000_000, stocktakeDate: '2026-10-20', location: 'Сүхбаатар дүүрэг' },
    ...overrides,
  });

export const makeList = (items: CollateralView[], overrides: Partial<CollateralListResponse> = {}): CollateralListResponse => ({
  items,
  summary: makeSummary({ count: items.length }),
  gate: makeGate(),
  warnings: [],
  ...overrides,
});

export const makeMutation = (collateral: CollateralView, overrides: Partial<Omit<CollateralMutationResponse, 'collateral'>> = {}): CollateralMutationResponse => ({
  collateral,
  summary: makeSummary({ count: 1 }),
  gate: makeGate(),
  warnings: [],
  ...overrides,
});

export const makeBorrower = (overrides: Partial<BorrowerView> & { name?: string } = {}): BorrowerView => {
  const { name, ...rest } = overrides;
  return {
    id: '0a1b2c3d-6666-4a66-8a66-000000000001',
    applicationId: IDS.app,
    customerId: IDS.owner,
    role: 'PRIMARY',
    isPrimary: true,
    relationToPrimary: null,
    liabilityShare: null,
    guaranteeType: null,
    guaranteeAmount: null,
    consentFileId: null,
    consentSignedAt: null,
    incomeIncluded: true,
    note: null,
    customer: { id: IDS.owner, customerType: 'INDIVIDUAL', displayName: name ?? 'Бат Болд', registerNoMasked: 'УБ******78', phone: null, email: null, isPep: false, isRelatedParty: false },
    createdAt: NOW,
    ...rest,
  };
};

export const makeBorrowerList = (items: BorrowerView[] = [makeBorrower()], editable = true): BorrowerListResponse => ({
  items,
  summary: {
    primaryCount: items.filter((i) => i.role === 'PRIMARY').length,
    coBorrowerCount: items.filter((i) => i.role === 'CO_BORROWER').length,
    guarantorCount: items.filter((i) => i.role === 'GUARANTOR').length,
    pledgorCount: items.filter((i) => i.role === 'PLEDGOR').length,
    clientStepComplete: items.some((i) => i.role === 'PRIMARY'),
    primaryLiabilityShare: null,
    incomeContributorCustomerIds: [],
    guaranteeCoverageRatio: null,
    limits: { maxCoBorrowers: 2, maxGuarantors: 2 },
    editable,
  },
  warnings: [],
});
