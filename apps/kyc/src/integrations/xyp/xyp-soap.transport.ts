// ХУР-ын SOAP тээвэр (gsb: zeep). Endpoint, namespace, SOAPAction-ийг WSDL-ээс АЖИЛЛАХ ҮЕД уншдаг (`soap` = node-soap) — repo-д байхгүй тул зохиохгүй.
// gsb-ээс ялгаа: (1) WSDL-ийг нэг л удаа татаж cache хийнэ (gsb дуудлага бүрд), алдааг cache хийхгүй; (2) TLS сертификатын шалгалт ИДЭВХТЭЙ хэвээр (gsb-д унтраалттай байсан — хуулбарлаагүй);
// (3) header-ийг дуудлага бүрээр тусад нь өгнө (клиентийн төлөв хуваалцахгүй → зэрэг дуудлагад гарын үсэг холилдохгүй).
import { createClientAsync, type Client, type SoapMethodAsync } from 'soap';

export interface XypSoapTransportOptions {
  wsdlUrl: string;
  timeoutMs: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`XYP timeout after ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class XypSoapTransport {
  private client: Promise<Client> | null = null;

  constructor(private readonly opts: XypSoapTransportOptions) {}

  private getClient(): Promise<Client> {
    this.client ??= withTimeout(createClientAsync(this.opts.wsdlUrl, { wsdl_options: { timeout: this.opts.timeoutMs } }), this.opts.timeoutMs).catch((e: unknown) => {
      this.client = null; // түр алдааг cache хийхгүй: дараагийн дуудлага дахин оролдоно
      throw e;
    });
    return this.client;
  }

  /** @returns SOAP хариуны бие (wrapper-ийн хүүхдүүд). Алдаа (fault, сүлжээ, timeout) шидэгдэнэ — дуудагч нь ангилна. */
  async call(operation: string, args: object, headers: Record<string, string>): Promise<unknown> {
    const client = await this.getClient();
    const method = (client as unknown as Record<string, SoapMethodAsync | undefined>)[`${operation}Async`];
    if (typeof method !== 'function') throw new Error(`XYP operation ${operation} is not in the WSDL`);
    const [result] = await withTimeout(method.call(client, args, { timeout: this.opts.timeoutMs }, headers), this.opts.timeoutMs);
    return result;
  }
}
