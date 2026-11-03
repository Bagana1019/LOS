import type { CreateCustomerRequest, CustomerCard, CustomerLookup, CustomerPage, CustomerView, XypFetchResult } from '@los/contracts';
import { originationFetch, qs } from '../../lib/api';

// Gateway → origination: `/api/origination/customers…` (apps/origination/src/modules/customer, FR-2).
const enc = encodeURIComponent;
export type CustomerListParams = { q?: string; customerType?: string; page?: number; pageSize?: number };

export const fetchCustomers = (params: CustomerListParams): Promise<CustomerPage> => originationFetch<CustomerPage>(`/customers${qs(params)}`);
export const lookupCustomer = (registerNo: string): Promise<CustomerLookup> => originationFetch<CustomerLookup>(`/customers/lookup${qs({ registerNo })}`);
/** Хадгалахгүй: ХУР-аас татаж маягтын өгөгдөл + дутуу талбарын жагсаалт буцаана. */
export const xypFetch = (registerNo: string): Promise<XypFetchResult> => originationFetch<XypFetchResult>('/customers/xyp-fetch', { method: 'POST', json: { registerNo } });
export const createCustomer = (body: CreateCustomerRequest | Record<string, unknown>): Promise<CustomerView> => originationFetch<CustomerView>('/customers', { method: 'POST', json: body });
export const fetchCustomerCard = (id: string): Promise<CustomerCard> => originationFetch<CustomerCard>(`/customers/${enc(id)}`);
