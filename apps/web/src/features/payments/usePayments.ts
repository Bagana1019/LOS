import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BankNameCheckRequest, BankReconcileRequest, CreatePaymentInvoiceRequest, PaymentInvoiceView, PaymentSimulateRequest } from '@los/contracts';
import * as api from './payments.api';
import { isAlreadyPaidError, isStaleStateError, pollInterval } from './payment.utils';

// Query түлхүүр: ['payments', applicationId, 'status'|'list'|'invoice', …]. Төлбөр орсны дараа `['payments', applicationId]`-г бүхэлд нь шинэчилнэ.
export const paymentsKey = (applicationId: string) => ['payments', applicationId] as const;
export const repaymentStatusKey = (applicationId: string) => [...paymentsKey(applicationId), 'status'] as const;
export const paymentListKey = (applicationId: string) => [...paymentsKey(applicationId), 'list'] as const;
export const invoiceKey = (applicationId: string, invoiceId: string) => [...paymentsKey(applicationId), 'invoice', invoiceId] as const;
export const providersKey = ['payment-providers'] as const;

/** 4xx (эрх, олдсонгүй, дүрмийн зөрчил) дахин оролдсоноор засагдахгүй. Сүлжээ/серверийн алдааг л нэг удаа дахин оролдоно. */
const retryTransient = (failureCount: number, error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return failureCount < 1 && !(typeof status === 'number' && status < 500);
};

export function useProviders() {
  return useQuery({ queryKey: providersKey, queryFn: api.fetchProviders, staleTime: 60_000, retry: retryTransient });
}

export function useRepaymentStatus(applicationId: string) {
  return useQuery({ queryKey: repaymentStatusKey(applicationId), queryFn: () => api.fetchRepaymentStatus(applicationId), retry: retryTransient });
}

export function usePaymentList(applicationId: string) {
  return useQuery({ queryKey: paymentListKey(applicationId), queryFn: () => api.fetchPayments(applicationId), retry: retryTransient });
}

/**
 * Invoice-ийг 3 секунд тутам шалгана (PENDING үед). GET нь сервер талд провайдераас шалгаж шинэчилдэг тул callback алдагдсан ч төлбөр мэдэгдэнэ.
 * Эцсийн төлөвт (PAID/EXPIRED/CANCELLED) зогсоно. Түр алдаа гарсан ч өмнөх өгөгдлөөр үргэлжлүүлэн шалгана.
 */
export function useInvoice(applicationId: string, invoiceId: string | null) {
  return useQuery({
    queryKey: invoiceKey(applicationId, invoiceId ?? ''),
    queryFn: () => api.fetchInvoice(invoiceId as string),
    enabled: invoiceId !== null,
    staleTime: 2_000,
    refetchInterval: (query) => pollInterval(query.state.data?.status),
    refetchIntervalInBackground: true,
    retry: retryTransient,
  });
}

/** Үүссэн/шинэчлэгдсэн invoice-ийг кэшэнд тавьж, polling-д шууд ашиглуулна. */
function useCacheInvoice(applicationId: string) {
  const queryClient = useQueryClient();
  return (invoice: PaymentInvoiceView) => queryClient.setQueryData(invoiceKey(applicationId, invoice.id), invoice);
}

/** 404/409 (мөр аль хэдийн төлөгдсөн, зээл хаагдсан гэх мэт) — ЭТХ-ийн төлөв манайхаас зөрсөн тул дахин татна. */
export function useCreateInvoice(applicationId: string) {
  const queryClient = useQueryClient();
  const cache = useCacheInvoice(applicationId);
  return useMutation({
    mutationFn: (body: CreatePaymentInvoiceRequest) => api.createInvoice(body),
    onSuccess: cache,
    onError: (error) => {
      if (isStaleStateError(error)) void queryClient.invalidateQueries({ queryKey: repaymentStatusKey(applicationId) });
    },
  });
}

/**
 * Цуцлах. 409 INVOICE_ALREADY_PAID бол төлбөр яг одоо орсон гэсэн үг — invoice-ийг дахин татаж, жагсаалтыг шинэчилнэ.
 * 404/409 бусад тохиолдолд ч сервер дээрх төлөв зөрсөн тул invoice-ийг дахин татна.
 */
export function useCancelInvoice(applicationId: string) {
  const queryClient = useQueryClient();
  const cache = useCacheInvoice(applicationId);
  return useMutation({
    mutationFn: (invoiceId: string) => api.cancelInvoice(invoiceId),
    onSuccess: cache,
    onError: (error, invoiceId) => {
      if (isAlreadyPaidError(error)) void queryClient.invalidateQueries({ queryKey: paymentsKey(applicationId) });
      else if (isStaleStateError(error)) void queryClient.invalidateQueries({ queryKey: invoiceKey(applicationId, invoiceId) });
    },
  });
}

/** "Туршилтын төлөлт" (зөвхөн mock). Амжилттай бол invoice (PAID болсон байх) кэшлэгдэж, ЭТХ/түүх шинэчлэгдэнэ. */
export function useSimulatePayment(applicationId: string) {
  const queryClient = useQueryClient();
  const cache = useCacheInvoice(applicationId);
  return useMutation({
    mutationFn: (body: PaymentSimulateRequest) => api.simulatePayment(body),
    onSuccess: (invoice) => {
      cache(invoice);
      void queryClient.invalidateQueries({ queryKey: paymentsKey(applicationId) });
    },
  });
}

/** Банкны тулгалт (ADMIN). Шинэ төлбөр орсон байж болох тул бүх төлбөрийн query-г шинэчилнэ. */
export function useReconcile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: BankReconcileRequest) => api.reconcileBankTransfers(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['payments'] }),
  });
}

export function useNameCheck() {
  return useMutation({ mutationFn: (body: BankNameCheckRequest) => api.checkBankAccountName(body) });
}
