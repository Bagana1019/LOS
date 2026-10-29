// Gateway-ийн дамжуулсан толгойноос үүсэх хүсэлтийн контекст (CLAUDE.md §3.2.9 + GATEWAY_HEADERS).
export interface RequestContext {
  userId: string;
  roles: string[];
  orgId: string;
  branchId: string | null;
  merchantId: string | null;
  storeId: string | null;
  correlationId: string;
}
