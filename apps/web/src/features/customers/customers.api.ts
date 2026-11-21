import type { CreateCustomerRequest, CustomerCard, CustomerLookup, CustomerPage, CustomerView, XypFetchResult, XypOtpResult } from '@los/contracts';
import { originationFetch, qs } from '../../lib/api';

// Gateway → origination: `/api/origination/customers…` (apps/origination/src/modules/customer, FR-2).
const enc = encodeURIComponent;
export type CustomerListParams = { q?: string; customerType?: string; page?: number; pageSize?: number };

export const fetchCustomers = (params: CustomerListParams): Promise<CustomerPage> => originationFetch<CustomerPage>(`/customers${qs(params)}`);
export const lookupCustomer = (registerNo: string): Promise<CustomerLookup> => originationFetch<CustomerLookup>(`/customers/lookup${qs({ registerNo })}`);
/** Иргэний зөвшөөрөл, 1-р алхам: ХУР иргэний БҮРТГЭЛТЭЙ утсанд нэг удаагийн код илгээнэ. Утасны дугаар ЯВУУЛАХГҮЙ (сервер ч хүлээн авахгүй). */
export const xypRequestOtp = (registerNo: string): Promise<XypOtpResult> => originationFetch<XypOtpResult>('/customers/xyp-otp', { method: 'POST', json: { registerNo } });
/** 2-р алхам, хадгалахгүй: иргэний кодоор ХУР-аас татаж маягтын өгөгдөл + дутуу талбарын жагсаалт + `snapshotToken` буцаана. */
export const xypFetch = (registerNo: string, otp: string): Promise<XypFetchResult> => originationFetch<XypFetchResult>('/customers/xyp-fetch', { method: 'POST', json: { registerNo, otp } });
export const createCustomer = (body: CreateCustomerRequest | Record<string, unknown>): Promise<CustomerView> => originationFetch<CustomerView>('/customers', { method: 'POST', json: body });
export const fetchCustomerCard = (id: string): Promise<CustomerCard> => originationFetch<CustomerCard>(`/customers/${enc(id)}`);
/** F1-15: хэсэгчилсэн засвар (`UpdateCustomerRequest`): өгсөн талбарыг л солино, `""` = арилгах. Регистр/төрөл явуулбал сервер 400 READONLY_FIELD. */
export const updateCustomer = (id: string, body: Record<string, unknown>): Promise<CustomerView> => originationFetch<CustomerView>(`/customers/${enc(id)}`, { method: 'PUT', json: body });
