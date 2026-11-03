import { IncomeOverviewResponse, type IncomeCalculateBody, type IncomeExpensesBody, type IncomeManualInput, type IncomeSalaryInput } from '@los/contracts';
import { originationFetch } from '../../lib/api';

// Gateway-н замаар origination руу; origination-ий зам: `/applications/:applicationId/income…`. Бүх мутаци шинэчилсэн `IncomeOverviewResponse` буцаана.
const base = (id: string): string => `/applications/${encodeURIComponent(id)}/income`;
const parse = { schema: IncomeOverviewResponse } as const;

export const fetchIncome = (id: string): Promise<IncomeOverviewResponse> => originationFetch(base(id), parse);
export const fetchNdsh = (id: string, customerId: string): Promise<IncomeOverviewResponse> => originationFetch(`${base(id)}/ndsh/fetch`, { method: 'POST', json: { customerId }, ...parse });
export const addSalary = (id: string, body: IncomeSalaryInput): Promise<IncomeOverviewResponse> => originationFetch(`${base(id)}/salaries`, { method: 'POST', json: body, ...parse });
export const removeSalary = (id: string, salaryId: string): Promise<IncomeOverviewResponse> => originationFetch(`${base(id)}/salaries/${encodeURIComponent(salaryId)}`, { method: 'DELETE', ...parse });
export const calculate = (id: string, body: IncomeCalculateBody): Promise<IncomeOverviewResponse> => originationFetch(`${base(id)}/calculate`, { method: 'POST', json: body, ...parse });
export const addManual = (id: string, body: IncomeManualInput): Promise<IncomeOverviewResponse> => originationFetch(`${base(id)}/manual`, { method: 'POST', json: body, ...parse });
export const removeManual = (id: string, manualId: string): Promise<IncomeOverviewResponse> => originationFetch(`${base(id)}/manual/${encodeURIComponent(manualId)}`, { method: 'DELETE', ...parse });
export const setExpenses = (id: string, customerId: string, body: IncomeExpensesBody): Promise<IncomeOverviewResponse> => originationFetch(`${base(id)}/expenses/${encodeURIComponent(customerId)}`, { method: 'PUT', json: body, ...parse });
export const refreshIncome = (id: string): Promise<IncomeOverviewResponse> => originationFetch(`${base(id)}/refresh`, { method: 'POST', ...parse });
