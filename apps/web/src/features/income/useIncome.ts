import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IncomeCalculateBody, IncomeExpensesBody, IncomeManualInput, IncomeOverviewResponse, IncomeSalaryInput } from '@los/contracts';
import * as api from './income.api';

export const incomeKey = (applicationId: string) => ['income', applicationId] as const;

export const useIncome = (applicationId: string) => useQuery({ queryKey: incomeKey(applicationId), queryFn: () => api.fetchIncome(applicationId), retry: false });

/** Мутаци шинэчилсэн дүнг шууд кэшэд тавьж, `onChanged` (wizard-ийн алхмын төлөв) дуудна. */
function useIncomeMutation<TVars>(applicationId: string, fn: (v: TVars) => Promise<IncomeOverviewResponse>, onChanged?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (res) => {
      qc.setQueryData(incomeKey(applicationId), res);
      onChanged?.();
    },
  });
}

export const useFetchNdsh = (id: string, onChanged?: () => void) => useIncomeMutation(id, (customerId: string) => api.fetchNdsh(id, customerId), onChanged);
export const useAddSalary = (id: string, onChanged?: () => void) => useIncomeMutation(id, (b: IncomeSalaryInput) => api.addSalary(id, b), onChanged);
export const useRemoveSalary = (id: string, onChanged?: () => void) => useIncomeMutation(id, (salaryId: string) => api.removeSalary(id, salaryId), onChanged);
export const useCalculate = (id: string, onChanged?: () => void) => useIncomeMutation(id, (b: IncomeCalculateBody) => api.calculate(id, b), onChanged);
export const useAddManual = (id: string, onChanged?: () => void) => useIncomeMutation(id, (b: IncomeManualInput) => api.addManual(id, b), onChanged);
export const useRemoveManual = (id: string, onChanged?: () => void) => useIncomeMutation(id, (manualId: string) => api.removeManual(id, manualId), onChanged);
export const useSetExpenses = (id: string, onChanged?: () => void) => useIncomeMutation(id, (v: { customerId: string; body: IncomeExpensesBody }) => api.setExpenses(id, v.customerId, v.body), onChanged);
export const useRefreshIncome = (id: string, onChanged?: () => void) => useIncomeMutation(id, () => api.refreshIncome(id), onChanged);
