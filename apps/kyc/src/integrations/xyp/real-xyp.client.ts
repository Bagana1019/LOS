import { customerTypeOfRegister, type XypAssetsResponse, type XypCitizen, type XypPropertyAsset } from '@los/contracts';
import { IntegrationNotConfiguredError, IntegrationNotImplementedError } from '../errors';
import { isProduction } from '../integration-env';
import { mapCitizenResponse } from './xyp-citizen.mapper';
import { signXypRequest } from './xyp-signer';
import { XypSoapTransport } from './xyp-soap.transport';
import { loadXypConfig, type ReadFile, type XypConfig } from './xyp.config';
import { XypOtpNotSentError, XypOtpRejectedError, XypUnavailableError, type XypClient } from './xyp.client';
import { classifyXypResultCode, parseXypResultCode, type XypResultOutcome } from './xyp-result-code';

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

/** gsb-ийн жинхэнэ үйлдлийн нэр (иргэний үнэмлэхийн мэдээлэл). */
const CITIZEN_OPERATION = 'WS100101_getCitizenIDCardInfo';
/**
 * resultCode-той хариуг `xyp-result-code.ts` (албан ёсны хүснэгт) ангилна. Энэ текстийн дүрэм зөвхөн (a) resultCode-гүй SOAP fault-д, (b) хүснэгтэд БАЙХГҮЙ кодод
 * (gsb-ийн алдааны текстээр таних арга: otp_approve.py:44-61, users.py:818-849). Танигдаагүй алдаа → XypUnavailableError, «олдсонгүй» гэж таамаглахгүй.
 */
const NOT_FOUND = /олдсонгүй|бүртгэлгүй|not found/i; // «алдаатай хүсэлт» зориуд ороогүй: буруу token / гарын үсэг ч ингэж харагдаж болно (review M3)

/** Хариуны wrapper-ийн resultCode: байхгүй (undefined / null) бол `absent`; байгаа ч тоо биш (хоосон, текст) бол `code: undefined`. */
function resultCodeOf(body: Row): { absent: boolean; code: number | undefined } {
  const raw = body.resultCode;
  return { absent: raw === undefined || raw === null, code: parseXypResultCode(raw) };
}

const outcomeOf = (code: number | undefined): XypResultOutcome => (code === undefined ? 'UNKNOWN' : classifyXypResultCode(code));

/** WS100101 resultCode≠0: «олдсонгүй» → null; бусад → throw. Хүснэгтэд байгаа код текстээс давамгай. */
function citizenFailure(code: number | undefined, message: string): null {
  const outcome = outcomeOf(code);
  if (outcome === 'NOT_FOUND') return null;
  if (outcome === 'CODE_REJECTED') throw new XypOtpRejectedError({ resultCode: code }); // 1001 / 1002: ХУР хариулсан — код буруу / олдсонгүй
  if (outcome === 'UNKNOWN') { // хүснэгтэд байхгүй код: текстийн дүрэм (ТААМАГЛАЛ)
    if (NOT_FOUND.test(message)) return null;
    if (isXypCodeRejection(message)) throw new XypOtpRejectedError({ resultCode: code });
  }
  throw new XypUnavailableError(undefined, { resultCode: code }); // кодтой холбоогүй (доголдол, token / гарын үсэг, код шалгах системийн алдаа): код буруу гэж хэлэхгүй
}

/** WS100008 resultCode≠0: «олдсонгүй» → false; 1005 / 1006 → XypOtpNotSentError; бусад → XypUnavailableError (SMS явсан эсэх тодорхойгүй). */
function otpRequestFailure(code: number | undefined, message: string): false {
  const outcome = outcomeOf(code);
  if (outcome === 'NOT_FOUND') return false;
  if (outcome === 'CODE_NOT_SENT') throw new XypOtpNotSentError({ resultCode: code });
  if (outcome === 'UNKNOWN' && NOT_FOUND.test(message)) return false;
  throw new XypUnavailableError(undefined, { resultCode: code });
}

/** «Иргэн олдсонгүй» гэж ЗӨВХӨН жинхэнэ SOAP fault-ийн faultstring таарвал үзнэ. Сүлжээ / HTTP / тодорхойгүй алдаа, ерөнхий «алдаатай хүсэлт» → false. */
export function isXypNotFoundFault(e: unknown): boolean {
  const fault = (e as { root?: { Envelope?: { Body?: { Fault?: { faultstring?: unknown } } } } } | null | undefined)?.root?.Envelope?.Body?.Fault;
  return typeof fault?.faultstring === 'string' && NOT_FOUND.test(fault.faultstring);
}

/** WS100008: иргэний ХУР-д бүртгэлтэй утсанд нэг удаагийн код илгээнэ (`meta` WSDL; vendor demo OTPApprove.py). */
const OTP_REQUEST_OPERATION = 'WS100008_registerOTPRequest';
/** Иргэний код: 4–8 цифр (ТААМАГЛАЛ; contracts XypOtpCode-той ижил). Хэлбэр буруу бол ХУР руу явуулахгүй. */
const OTP_PATTERN = /^\d{4,8}$/;
/** vendor demo (OTPApprove.py): биометр огт ашиглахгүй гэсэн placeholder (base64Binary). */
const NO_ACCESS_FINGERPRINT = Buffer.from('*** NO ACCESS ***').toString('base64');
/** `otp = 0` нь «код хараахан байхгүй» (WS100008 хүсэлт); бодит код нь int болж явна. Тохируулаагүй талбарыг (certFingerprint, signature, civilId …) ИЛГЭЭХГҮЙ — WSDL-ээр баталгаажуулна. */
const otpAuth = (registerNo: string, otp: number) => ({
  citizen: { regnum: registerNo, otp, fingerprint: NO_ACCESS_FINGERPRINT },
  operator: { otp: 0, fingerprint: NO_ACCESS_FINGERPRINT },
});
/**
 * WS100101-ийн иргэний баталгаажуулалтын төрөл: 1 = нэг удаагийн код (ХУР-ын албан ёсны "Сервис дуудах" жишээ). ЗӨВХӨН код өгөх үед: WS100008-д (otp=0) явуулбал
 * ХУР «код олдсонгүй» (1001) гэж хариулна.
 */
const CITIZEN_AUTH_TYPE_OTP = 1;
const verifyAuth = (registerNo: string, otp: number) => {
  const base = otpAuth(registerNo, otp);
  return { ...base, citizen: { authType: CITIZEN_AUTH_TYPE_OTP, ...base.citizen } };
};

/**
 * Код өгсний дараах SOAP fault (resultCode-гүй) эсвэл хүснэгтэд БАЙХГҮЙ resultCode-ийн мессежийг «код буруу / хугацаа дууссан» гэж ангилах дүрэм (resultCode 1001 / 1002 нь
 * `xyp-result-code.ts`-аар шууд ангилагдана). fault-ийн бодит текст нь хүснэгтэд байхгүй (VPN-ээр баталгаажуулна) тул ТААМАГЛАЛ. Танигдаагүй нь «код буруу» БИШ: ХУР-ын доголдол, `XYP_ACCESS_TOKEN` дууссан, гарын үсгийн алдааг «код буруу» гэвэл
 * ажилтан иргэнд дахин SMS илгээлгэж, аудитад хуурамч «код татгалзсан» бичлэг үүсгэж, доголдлыг нууна.
 * «код» гэсэн ганц үг ("Алдааны код 500") оруулдаггүй: кодтой холбоотой үг (буруу, хугацаа, expired …)-тай ойр байх ёстой.
 */
const CODE_WORD = '(?:код|code)';
const CODE_PROBLEM = '(?:буруу|алдаатай|хугацаа|дууссан|таарахгүй|invalid|expired|wrong|incorrect)';
const CODE_REJECTION = new RegExp(`otp|нэг удаагийн|passcode|verification|${CODE_WORD}.{0,24}${CODE_PROBLEM}|${CODE_PROBLEM}.{0,24}${CODE_WORD}`, 'i');
export const isXypCodeRejection = (text: string): boolean => CODE_REJECTION.test(text);

const faultString = (e: unknown): string => {
  const fault = (e as { root?: { Envelope?: { Body?: { Fault?: { faultstring?: unknown } } } } } | null | undefined)?.root?.Envelope?.Body?.Fault;
  return typeof fault?.faultstring === 'string' ? fault.faultstring : '';
};

/** ХУР SOAP fault-аар ХАРИУЛСАН бол faultcode-ийг (зөвхөн аюулгүй тэмдэгт, ≤40) буцаана; сүлжээ / HTTP / timeout (fault бүтэцгүй) → undefined. */
function soapFaultCode(e: unknown): string | undefined {
  const fault = (e as { root?: { Envelope?: { Body?: { Fault?: unknown } } } } | null | undefined)?.root?.Envelope?.Body?.Fault;
  if (!isRow(fault)) return undefined;
  return typeof fault.faultcode === 'string' ? fault.faultcode.replace(/[^\w:.-]/g, '').slice(0, 40) : 'fault';
}

export interface RealXypOptions {
  env?: Record<string, string | undefined>;
  readFile?: ReadFile;
  /** Гарын үсгийн цаг (ms). */
  now?: () => number;
}

/**
 * ХУР-ын бодит холболт (gsb: SOAP + WSDL, RSA гарын үсэг).
 * Хамрах хүрээ: ЗӨВХӨН иргэний үндсэн мэдээлэл (WS100101). gsb-д хөрөнгө (үл хөдлөх, тээвэр), хуулийн этгээд, ам бүл, гэр бүлийн байдал, тэтгэвэр, шүүх БАЙХГҮЙ →
 * `getAssets`, `getProperty`, хуулийн этгээдийн регистр fail-closed (IntegrationNotImplementedError); зохиомол хариу өгөхгүй.
 * Регистр, хариуг лог-д бичихгүй, алдааны мессежэд оруулахгүй (CLAUDE.md §6.5).
 */
export class RealXypClient implements XypClient {
  private ctx: { config: XypConfig; citizen: XypSoapTransport; meta: XypSoapTransport } | null = null;

  constructor(private readonly opts: RealXypOptions = {}) {}

  /** Тохиргоо дутуу бол IntegrationNotConfiguredError (сүлжээний дуудлагагүй); амжилттай ачаалсныг cache хийнэ. Хоёр тусдаа WSDL: citizen (WS100101) ба meta (WS100008). */
  private context(): { config: XypConfig; citizen: XypSoapTransport; meta: XypSoapTransport } {
    if (!this.ctx) {
      const config = loadXypConfig(this.opts.env, this.opts.readFile);
      const requireHttps = isProduction(this.opts.env ?? process.env);
      this.ctx = {
        config,
        citizen: new XypSoapTransport({ wsdlUrl: config.citizenWsdlUrl, timeoutMs: config.timeoutMs, endpointOverride: config.endpointOverride, requireHttps, endpointEnvName: 'XYP_CITIZEN_ENDPOINT_URL' }),
        meta: new XypSoapTransport({ wsdlUrl: config.metaWsdlUrl, timeoutMs: config.timeoutMs, endpointOverride: config.metaEndpointOverride, requireHttps, endpointEnvName: 'XYP_META_ENDPOINT_URL' }),
      };
    }
    return this.ctx;
  }

  private headers(config: XypConfig): Record<string, string> {
    return { ...signXypRequest({ accessToken: config.accessToken, privateKey: config.privateKey, nowMs: (this.opts.now ?? Date.now)() }) };
  }

  /**
   * Иргэний зөвшөөрөл (WS100008): ХУР иргэний БҮРТГЭЛТЭЙ утсанд (`phoneNum: 0`) SMS-ээр нэг удаагийн код илгээнэ; код зөвхөн WS100101-д хүчинтэй.
   * Утсыг дуудагч сонгохгүй: сонговол ажилтан кодыг өөрийн утсанд авч иргэний зөвшөөрлийг тойрно (gsb-д ингэж болдог — хуулбарлаагүй).
   * НЭГ л хүсэлт, дахин оролдохгүй: давхар илгээвэл иргэнд хоёр SMS очно. fault, resultCode≠0 биш бол «илгээгдсэн» (gsb-тэй ижил); resultCode 1005 / 1006 → XypOtpNotSentError.
   * Албан ёсны каталогт WS100008-ийн гаралт `status`, `resultMsg` (response доторх): ТЭДНИЙ утгыг ялгахгүй — амжилтын утга баталгаагүй, resultCode л шийднэ (docs/DECISIONS.md).
   */
  async requestCitizenOtp(registerNo: string): Promise<boolean> {
    if (customerTypeOfRegister(registerNo) !== 'INDIVIDUAL') throw new IntegrationNotImplementedError('xyp:legal-entity');
    const { config, meta } = this.context();
    const request = {
      auth: otpAuth(registerNo, 0), regnum: registerNo, jsonWSList: JSON.stringify([{ ws: CITIZEN_OPERATION }]),
      isSms: 1, isApp: 0, isEmail: 0, isKiosk: 0, phoneNum: 0,
    };
    let raw: unknown;
    try {
      raw = await meta.call(OTP_REQUEST_OPERATION, { request }, this.headers(config));
    } catch (e) {
      if (e instanceof IntegrationNotConfiguredError) throw e;
      if (isXypNotFoundFault(e)) return false;
      throw new XypUnavailableError(); // SMS явсан эсэх тодорхойгүй: хэрэглэгч хүлээгээд дахин хүснэ
    }
    const body = isRow(raw) && isRow(raw.return) ? raw.return : raw;
    if (isRow(body)) {
      const { absent, code } = resultCodeOf(body);
      if (!absent && code !== 0) return otpRequestFailure(code, String(body.resultMessage ?? ''));
    }
    return true;
  }

  async getCitizen(registerNo: string, otp: string): Promise<XypCitizen | null> {
    if (customerTypeOfRegister(registerNo) !== 'INDIVIDUAL') throw new IntegrationNotImplementedError('xyp:legal-entity');
    if (!OTP_PATTERN.test(otp)) throw new XypOtpRejectedError(); // хэлбэр буруу код ХУР руу явахгүй (нэг удаагийн кодыг шатаахгүй)
    const { config, citizen } = this.context();
    // Иргэний зөвшөөрөл: `auth.citizen.otp` (WS100008-аар иргэний утсанд очсон код). Код нууц: алдаа, лог, мессежэд орохгүй.
    const headers = this.headers(config);
    let raw: unknown;
    try {
      raw = await citizen.call(CITIZEN_OPERATION, { request: { auth: verifyAuth(registerNo, Number(otp)), regnum: registerNo } }, headers);
    } catch (e) {
      if (e instanceof IntegrationNotConfiguredError) throw e; // WSDL-ийн endpoint татгалзсан: тохиргооны алдаа, «олдсонгүй»/«түр ажиллахгүй» биш
      if (isXypNotFoundFault(e)) return null;
      const faultCode = soapFaultCode(e);
      if (faultCode !== undefined) {
        // ХУР fault-аар ХАРИУЛСАН: мессеж нь КОДТОЙ холбоотой бол «код буруу / хугацаа дууссан»; үгүй бол (доголдол, token / гарын үсгийн алдаа) «түр ажиллахгүй».
        if (isXypCodeRejection(faultString(e))) throw new XypOtpRejectedError({ faultCode });
        throw new XypUnavailableError(undefined, { faultCode });
      }
      throw new XypUnavailableError(); // сүлжээ, timeout, HTTP: код буруу гэж хэлэхгүй
    }
    // Хариуны wrapper (`return`) нь WSDL-ээс хамаарна — хоёр хэлбэрийг зөвшөөрнө.
    const body = isRow(raw) && isRow(raw.return) ? raw.return : raw;
    // Хоосон / танигдахгүй бие (redirect, HTML, тасарсан хариу) «иргэн олдсонгүй» БИШ: ХУР-ын хариу ядаж response / resultCode / resultMessage-ийн аль нэгийг агуулна.
    if (!isRow(body) || !('response' in body || 'resultCode' in body || 'resultMessage' in body)) throw new XypUnavailableError('ХУР-ын хариуны хэлбэр буруу байна');
    const { absent, code } = resultCodeOf(body);
    if (!absent && code !== 0) return citizenFailure(code, String(body.resultMessage ?? ''));
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
