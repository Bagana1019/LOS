import { customerTypeOfRegister, type XypAssetsResponse, type XypCitizen, type XypPropertyAsset } from '@los/contracts';
import { IntegrationNotImplementedError } from '../errors';
import { mapCitizenResponse } from './xyp-citizen.mapper';
import { signXypRequest } from './xyp-signer';
import { XypSoapTransport } from './xyp-soap.transport';
import { loadXypConfig, type ReadFile, type XypConfig } from './xyp.config';
import { XypUnavailableError, type XypClient } from './xyp.client';

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

/** gsb-ийн жинхэнэ үйлдлийн нэр (иргэний үнэмлэхийн мэдээлэл). */
const CITIZEN_OPERATION = 'WS100101_getCitizenIDCardInfo';
/**
 * «Олдсонгүй»-г ялгах цорын ганц нотлогдсон арга — gsb-ийн алдааны текстээр таних (otp_approve.py:44-61, users.py:818-849). ХУР-ын resultCode-ийн ХҮСНЭГТ repo-д байхгүй.
 * Танигдаагүй алдаа → XypUnavailableError (хэрэглэгч дахин оролдоно / гараар бөглөнө), «олдсонгүй» гэж таамаглахгүй.
 */
const NOT_FOUND = /олдсонгүй|бүртгэлгүй|алдаатай хүсэлт|not found/i;

export interface RealXypOptions {
  env?: Record<string, string | undefined>;
  readFile?: ReadFile;
  /** Гарын үсгийн цаг (ms). */
  now?: () => number;
}

/** SOAP fault / сүлжээний алдааны текст (зөвхөн «олдсонгүй» таних; хэрэглэгчид эсвэл лог руу ЭРГЭХГҮЙ). */
function errorText(e: unknown): string {
  const err = e as { message?: unknown; root?: { Envelope?: { Body?: { Fault?: { faultstring?: unknown } } } } } | null;
  return `${String(err?.message ?? '')} ${String(err?.root?.Envelope?.Body?.Fault?.faultstring ?? '')}`;
}

/**
 * ХУР-ын бодит холболт (gsb: SOAP + WSDL, RSA гарын үсэг).
 * Хамрах хүрээ: ЗӨВХӨН иргэний үндсэн мэдээлэл (WS100101). gsb-д хөрөнгө (үл хөдлөх, тээвэр), хуулийн этгээд, ам бүл, гэр бүлийн байдал, тэтгэвэр, шүүх БАЙХГҮЙ →
 * `getAssets`, `getProperty`, хуулийн этгээдийн регистр fail-closed (IntegrationNotImplementedError); зохиомол хариу өгөхгүй.
 * Регистр, хариуг лог-д бичихгүй, алдааны мессежэд оруулахгүй (CLAUDE.md §6.5).
 */
export class RealXypClient implements XypClient {
  private ctx: { config: XypConfig; transport: XypSoapTransport } | null = null;

  constructor(private readonly opts: RealXypOptions = {}) {}

  /** Тохиргоо дутуу бол IntegrationNotConfiguredError (сүлжээний дуудлагагүй); амжилттай ачаалсныг cache хийнэ. */
  private context(): { config: XypConfig; transport: XypSoapTransport } {
    if (!this.ctx) {
      const config = loadXypConfig(this.opts.env, this.opts.readFile);
      this.ctx = { config, transport: new XypSoapTransport({ wsdlUrl: config.citizenWsdlUrl, timeoutMs: config.timeoutMs }) };
    }
    return this.ctx;
  }

  async getCitizen(registerNo: string): Promise<XypCitizen | null> {
    if (customerTypeOfRegister(registerNo) !== 'INDIVIDUAL') throw new IntegrationNotImplementedError('xyp:legal-entity');
    const { config, transport } = this.context();
    // Иргэний зөвшөөрлийн баталгаа (OTP / цахим гарын үсэг)-гүй «хуучин» хэлбэр — FR-2.2 регистрээр л татдаг. ХУР үүнийг хүлээн авах эсэх нотлогдоогүй (DECISIONS).
    const headers = signXypRequest({ accessToken: config.accessToken, privateKey: config.privateKey, nowMs: (this.opts.now ?? Date.now)() });
    let raw: unknown;
    try {
      raw = await transport.call(CITIZEN_OPERATION, { request: { regnum: registerNo } }, { ...headers });
    } catch (e) {
      if (NOT_FOUND.test(errorText(e))) return null;
      throw new XypUnavailableError();
    }
    // Хариуны wrapper (`return`) нь WSDL-ээс хамаарна — хоёр хэлбэрийг зөвшөөрнө.
    const body = isRow(raw) && isRow(raw.return) ? raw.return : raw;
    if (!isRow(body)) throw new XypUnavailableError('ХУР-ын хариуны хэлбэр буруу байна');
    if (body.resultCode !== undefined && body.resultCode !== null && Number(body.resultCode) !== 0) {
      if (NOT_FOUND.test(String(body.resultMessage ?? ''))) return null;
      throw new XypUnavailableError();
    }
    if (!isRow(body.response) || Object.keys(body.response).length === 0) return null;
    return mapCitizenResponse(registerNo, body.response, new Date((this.opts.now ?? Date.now)()));
  }

  async getAssets(_registerNo: string): Promise<XypAssetsResponse | null> {
    throw new IntegrationNotImplementedError('xyp:assets');
  }

  async getProperty(_propertyId: string): Promise<XypPropertyAsset | null> {
    throw new IntegrationNotImplementedError('xyp:property');
  }
}
