import type { HttpResponse } from './http.types';

/**
 * Merchant API-ийн бүх хариуг (амжилт ба алдаа) хөтөч/завсрын кэшэд хадгалуулахгүй: хуваалцсан POS терминал дээр худалдан авагчийн нэр, масклагдсан регистр/утас,
 * шийдвэр, мерчантын dashboard кэшэнд үлдэх ёсгүй (POS-BR-7). Middleware тул guard-ийн 401/403 хариунд ч тавигдана.
 * Зөвхөн MerchantModule-ийн controller-уудад (module.configure) — глобал биш.
 */
export function noStoreMiddleware(_req: unknown, res: Pick<HttpResponse, 'setHeader'>, next: () => void): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}
