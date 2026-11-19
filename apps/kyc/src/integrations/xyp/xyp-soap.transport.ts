// ХУР-ын SOAP тээвэр (gsb: zeep). Endpoint, namespace, SOAPAction-ийг WSDL-ээс АЖИЛЛАХ ҮЕД уншдаг (`soap` = node-soap) — repo-д байхгүй тул зохиохгүй.
// gsb-ээс ялгаа: (1) WSDL-ийг нэг л удаа татаж cache хийнэ (gsb дуудлага бүрд), алдааг cache хийхгүй; (2) TLS сертификатын шалгалт ИДЭВХТЭЙ хэвээр (gsb-д унтраалттай байсан — хуулбарлаагүй);
// (3) header-ийг дуудлага бүрээр тусад нь өгнө (клиентийн төлөв хуваалцахгүй → зэрэг дуудлагад гарын үсэг холилдохгүй).
import { createClientAsync, type Client, type SoapMethodAsync } from 'soap';
import { IntegrationNotConfiguredError } from '../errors';

export interface XypSoapTransportOptions {
  wsdlUrl: string;
  timeoutMs: number;
  /** Тодорхой SOAP endpoint (тохируулсан бол WSDL-ийн зарласан хаягийг орлоно). */
  endpointOverride?: string;
  /** production: WSDL-ийн зарласан endpoint заавал https. */
  requireHttps: boolean;
}

interface WsdlServices { [service: string]: { ports?: { [port: string]: { location?: unknown } } } }

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`XYP timeout after ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class XypSoapTransport {
  private client: Promise<Client> | null = null;

  constructor(private readonly opts: XypSoapTransportOptions) {}

  private getClient(): Promise<Client> {
    // maxRedirects: 0 — WSDL, SOAP дуудлага аль нь ч redirect ДАГАХГҮЙ (нууц header, регистр өөр хост руу дамжихгүй).
    const created = createClientAsync(this.opts.wsdlUrl, { wsdl_options: { timeout: this.opts.timeoutMs, maxRedirects: 0 } }, this.opts.endpointOverride).then((client) => {
      this.assertDeclaredEndpoints(client);
      return client;
    });
    this.client ??= withTimeout(created, this.opts.timeoutMs).catch((e: unknown) => {
      this.client = null; // түр алдааг cache хийхгүй: дараагийн дуудлага дахин оролдоно
      throw e;
    });
    return this.client;
  }

  /**
   * Бодит SOAP дуудлага WSDL-ийн `soap:address`-т очдог тул WSDL-ийн хаягийг ЗӨВХӨН итгэмжлэгдсэн үед л ашиглана: WSDL-ийн хостой ижил хост, production-д https,
   * уншиж чадахгүй бол татгалзана (fail closed). Тодорхой `endpointOverride` өгсөн бол (production-д https нь startup-д шалгагдсан) шалгахгүй.
   * Алдааны мессежэд хост, URL оруулахгүй.
   */
  private assertDeclaredEndpoints(client: Client): void {
    if (this.opts.endpointOverride) return;
    const services = (client as unknown as { wsdl?: { definitions?: { services?: WsdlServices } } }).wsdl?.definitions?.services ?? {};
    const locations = Object.values(services).flatMap((s) => Object.values(s.ports ?? {}).map((p) => p.location));
    const wsdlHost = new URL(this.opts.wsdlUrl).hostname.toLowerCase();
    const trusted = locations.length > 0 && locations.every((loc) => {
      try {
        const url = new URL(String(loc));
        return url.hostname.toLowerCase() === wsdlHost && (!this.opts.requireHttps || url.protocol === 'https:');
      } catch {
        return false;
      }
    });
    if (!trusted) throw new IntegrationNotConfiguredError('xyp', ['XYP_CITIZEN_ENDPOINT_URL (WSDL endpoint rejected)']);
  }

  /** @returns SOAP хариуны бие (wrapper-ийн хүүхдүүд). Алдаа (fault, сүлжээ, timeout) шидэгдэнэ — дуудагч нь ангилна. */
  async call(operation: string, args: object, headers: Record<string, string>): Promise<unknown> {
    const client = await this.getClient();
    const method = (client as unknown as Record<string, SoapMethodAsync | undefined>)[`${operation}Async`];
    if (typeof method !== 'function') throw new Error(`XYP operation ${operation} is not in the WSDL`);
    const [result] = await withTimeout(method.call(client, args, { timeout: this.opts.timeoutMs, maxRedirects: 0 }, headers), this.opts.timeoutMs);
    return result;
  }
}
