import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as soap from 'soap';
import { afterEach, describe, expect, it } from 'vitest';
import { IntegrationNotConfiguredError, IntegrationNotImplementedError } from '../errors';
import { isXypCodeRejection, isXypNotFoundFault, RealXypClient } from './real-xyp.client';
import { XypOtpRejectedError, XypUnavailableError } from './xyp.client';

// Бодит `soap` номын сангаар локал SOAP серверт (127.0.0.1) хийсэн wire-level тест. Бодит ХУР-т хандаагүй.
// АНХААР: WSDL нь ШИНЖИЛГЭЭНИЙ ЗОРИУЛАЛТТАЙ загвар. Нотлогдсон: үйлдлийн нэр WS100101_getCitizenIDCardInfo, хариуны response/resultCode/resultMessage,
// гарын үсгийн header. ТААМАГЛАЛ (бодит WSDL-ээр шалгана, VPN хэрэгтэй): хүсэлтийн `request` wrapper, хариуны `return` wrapper.
const TOKEN = 'TEST-ACCESS-TOKEN';
const REG = 'УБ90010112';
const OTP = '123456';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const verifies = (ts: string, sig: string): boolean => createVerify('RSA-SHA256').update(`${TOKEN}.${ts}`).verify(rsa.publicKey, sig, 'base64');

const DATA_FIELDS = ['firstname', 'lastname', 'gender', 'birthDateAsText', 'civilId', 'aimagCityName', 'soumDistrictName', 'bagKhorooName', 'addressStreetName', 'addressDetail', 'addressDoor', 'addressApartmentName', 'passportAddress', 'image'];
const wsdl = (soapPort: number, host = '127.0.0.1'): string => `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:test:citizen" targetNamespace="urn:test:citizen" name="CitizenService">
  <types><xsd:schema targetNamespace="urn:test:citizen" elementFormDefault="unqualified">
    <xsd:element name="WS100101_getCitizenIDCardInfo"><xsd:complexType><xsd:sequence><xsd:element name="request" type="tns:CitizenRequest"/></xsd:sequence></xsd:complexType></xsd:element>
    <xsd:element name="WS100101_getCitizenIDCardInfoResponse"><xsd:complexType><xsd:sequence><xsd:element name="return" type="tns:CitizenResult"/></xsd:sequence></xsd:complexType></xsd:element>
    <xsd:complexType name="CitizenRequest"><xsd:sequence><xsd:element name="auth" type="tns:Auth" minOccurs="0"/><xsd:element name="regnum" type="xsd:string"/></xsd:sequence></xsd:complexType>
    <xsd:complexType name="Auth"><xsd:sequence><xsd:element name="citizen" type="tns:AuthParty" minOccurs="0"/><xsd:element name="operator" type="tns:AuthParty" minOccurs="0"/></xsd:sequence></xsd:complexType>
    <xsd:complexType name="AuthParty"><xsd:sequence><xsd:element name="fingerprint" type="xsd:base64Binary" minOccurs="0"/><xsd:element name="otp" type="xsd:int" minOccurs="0"/><xsd:element name="regnum" type="xsd:string" minOccurs="0"/></xsd:sequence></xsd:complexType>
    <xsd:complexType name="CitizenResult"><xsd:sequence>
      <xsd:element name="response" type="tns:CitizenData" minOccurs="0"/><xsd:element name="resultCode" type="xsd:int" minOccurs="0"/><xsd:element name="resultMessage" type="xsd:string" minOccurs="0"/>
    </xsd:sequence></xsd:complexType>
    <xsd:complexType name="CitizenData"><xsd:sequence>${DATA_FIELDS.map((f) => `<xsd:element name="${f}" type="xsd:string" minOccurs="0"/>`).join('')}</xsd:sequence></xsd:complexType>
  </xsd:schema></types>
  <message name="in"><part name="parameters" element="tns:WS100101_getCitizenIDCardInfo"/></message>
  <message name="out"><part name="parameters" element="tns:WS100101_getCitizenIDCardInfoResponse"/></message>
  <portType name="CitizenPort"><operation name="WS100101_getCitizenIDCardInfo"><input message="tns:in"/><output message="tns:out"/></operation></portType>
  <binding name="CitizenBinding" type="tns:CitizenPort"><soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="WS100101_getCitizenIDCardInfo"><soap:operation soapAction="urn:test:citizen:WS100101"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation></binding>
  <service name="CitizenService"><port name="CitizenPort" binding="tns:CitizenBinding"><soap:address location="http://${host}:${soapPort}/citizen"/></port></service>
</definitions>`;

// WS100008_registerOTPRequest нь `meta` WSDL-д (vendor demo: https://xyp.gov.mn/meta-1.5.0/ws?WSDL). ШИНЖИЛГЭЭНИЙ загвар: `request`/`return` wrapper нь ТААМАГЛАЛ.
const metaWsdl = (soapPort: number, host = '127.0.0.1'): string => `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:test:meta" targetNamespace="urn:test:meta" name="MetaService">
  <types><xsd:schema targetNamespace="urn:test:meta" elementFormDefault="unqualified">
    <xsd:element name="WS100008_registerOTPRequest"><xsd:complexType><xsd:sequence><xsd:element name="request" type="tns:OtpRequest"/></xsd:sequence></xsd:complexType></xsd:element>
    <xsd:element name="WS100008_registerOTPRequestResponse"><xsd:complexType><xsd:sequence><xsd:element name="return" type="tns:OtpResult"/></xsd:sequence></xsd:complexType></xsd:element>
    <xsd:complexType name="OtpRequest"><xsd:sequence>
      <xsd:element name="auth" type="tns:Auth" minOccurs="0"/><xsd:element name="regnum" type="xsd:string"/><xsd:element name="jsonWSList" type="xsd:string"/>
      <xsd:element name="isSms" type="xsd:int"/><xsd:element name="isApp" type="xsd:int"/><xsd:element name="isEmail" type="xsd:int"/><xsd:element name="isKiosk" type="xsd:int"/><xsd:element name="phoneNum" type="xsd:long"/>
    </xsd:sequence></xsd:complexType>
    <xsd:complexType name="Auth"><xsd:sequence><xsd:element name="citizen" type="tns:AuthParty" minOccurs="0"/><xsd:element name="operator" type="tns:AuthParty" minOccurs="0"/></xsd:sequence></xsd:complexType>
    <xsd:complexType name="AuthParty"><xsd:sequence><xsd:element name="fingerprint" type="xsd:base64Binary" minOccurs="0"/><xsd:element name="otp" type="xsd:int" minOccurs="0"/><xsd:element name="regnum" type="xsd:string" minOccurs="0"/></xsd:sequence></xsd:complexType>
    <xsd:complexType name="OtpResult"><xsd:sequence><xsd:element name="resultCode" type="xsd:int" minOccurs="0"/><xsd:element name="resultMessage" type="xsd:string" minOccurs="0"/></xsd:sequence></xsd:complexType>
  </xsd:schema></types>
  <message name="in"><part name="parameters" element="tns:WS100008_registerOTPRequest"/></message>
  <message name="out"><part name="parameters" element="tns:WS100008_registerOTPRequestResponse"/></message>
  <portType name="MetaPort"><operation name="WS100008_registerOTPRequest"><input message="tns:in"/><output message="tns:out"/></operation></portType>
  <binding name="MetaBinding" type="tns:MetaPort"><soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="WS100008_registerOTPRequest"><soap:operation soapAction="urn:test:meta:WS100008"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation></binding>
  <service name="MetaService"><port name="MetaPort" binding="tns:MetaBinding"><soap:address location="http://${host}:${soapPort}/meta"/></port></service>
</definitions>`;

const citizen = (over: Record<string, unknown> = {}) => ({
  return: { resultCode: 0, resultMessage: 'Амжилттай', response: {
    firstname: 'Бат', lastname: 'Доржийн', gender: 'Эрэгтэй', birthDateAsText: '1990-01-01 00:00', civilId: '12345678', aimagCityName: 'Улаанбаатар', soumDistrictName: 'Сүхбаатар',
    bagKhorooName: '3-р хороо', addressStreetName: 'Энхтайвны өргөн чөлөө', addressDetail: '12', image: 'IMAGE-BASE64-SECRET', ...over,
  } },
});

/** Сервер талд задарсан SOAP хүсэлтийн бие (шинжилгээний WSDL-ийн хэлбэр). */
interface Wire {
  regnum: string; jsonWSList: string; isSms: number; isApp: number; isEmail: number; isKiosk: number; phoneNum: number;
  auth: { citizen: { regnum?: string; otp: number; fingerprint?: unknown }; operator: { regnum?: string; otp: number } };
}
interface Behavior { respond: (regnum: string) => unknown | Promise<unknown>; otpRespond: (regnum: string) => unknown | Promise<unknown>; wsdlStatus: number[] }
const listen = (s: Server): Promise<number> => new Promise((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
const close = (s: Server): Promise<void> => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); });

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

interface StartOptions {
  timeoutMs?: number;
  clock?: () => number;
  env?: Record<string, string | undefined>;
  /** WSDL-ийн зарласан endpoint: 'soap' (жинхэнэ сервер) | 'dead' (хаалттай порт) | 'redirector' (307-оор өөр сервер рүү). */
  declared?: 'soap' | 'dead' | 'redirector';
  /** WSDL-д зарласан хост (WSDL-ийн хостоос өөр байж болно). */
  declaredHost?: string;
  /** WSDL-ийг өөр сервер рүү 302-оор чиглүүлнэ. */
  wsdlRedirect?: boolean;
  /** XYP_CITIZEN_ENDPOINT_URL-ийг жинхэнэ SOAP сервер рүү заана. */
  override?: boolean;
}

async function start(opts: StartOptions = {}) {
  const behavior: Behavior = { respond: () => citizen(), otpRespond: () => ({ return: { resultCode: 0, resultMessage: 'ok' } }), wsdlStatus: [] };
  const seen: Array<{ headers: IncomingHttpHeaders; regnum: string; request: Wire }> = [];
  const seenOtp: Array<{ headers: IncomingHttpHeaders; request: Wire }> = [];
  const soapServer = createServer();
  const soapPort = await listen(soapServer);
  soap.listen(soapServer, '/citizen', {
    CitizenService: { CitizenPort: {
      WS100101_getCitizenIDCardInfo: (args: { request: Wire }, _cb: unknown, _h: unknown, req: { headers: IncomingHttpHeaders }) => {
        seen.push({ headers: req.headers, regnum: args.request.regnum, request: args.request });
        return behavior.respond(args.request.regnum);
      },
    } },
  }, wsdl(soapPort));
  soap.listen(soapServer, '/meta', {
    MetaService: { MetaPort: {
      WS100008_registerOTPRequest: (args: { request: Wire }, _cb: unknown, _h: unknown, req: { headers: IncomingHttpHeaders }) => {
        seenOtp.push({ headers: req.headers, request: args.request });
        return behavior.otpRespond(args.request.regnum);
      },
    } },
  }, metaWsdl(soapPort));
  // «Өөр» сервер: redirect-ийн зорилтот. Нэг ч хүсэлт хүлээн авч ЯВАХГҮЙ (redirect дагахгүй).
  let otherHits = 0;
  const other = createServer((_req, res) => { otherHits++; res.writeHead(200); res.end('x'); });
  const otherPort = await listen(other);
  const redirector = createServer((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${otherPort}/citizen` }); res.end(); });
  const redirectorPort = await listen(redirector);
  const declaredPort = opts.declared === 'dead' ? 1 : opts.declared === 'redirector' ? redirectorPort : soapPort;
  let wsdlHits = 0;
  let metaWsdlHits = 0;
  const wsdlServer = createServer((req, res) => {
    const meta = (req.url ?? '').startsWith('/meta');
    if (meta) metaWsdlHits++; else wsdlHits++;
    if (opts.wsdlRedirect) { res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/wsdl` }); res.end(); return; }
    const status = behavior.wsdlStatus.shift() ?? 200;
    res.writeHead(status, { 'content-type': 'text/xml' });
    res.end(status === 200 ? (meta ? metaWsdl(declaredPort, opts.declaredHost) : wsdl(declaredPort, opts.declaredHost)) : 'boom');
  });
  const wsdlPort = await listen(wsdlServer);
  cleanups.push(() => close(soapServer), () => close(wsdlServer), () => close(other), () => close(redirector));
  const env = {
    INTEGRATION_MODE: 'real', XYP_ACCESS_TOKEN: TOKEN, XYP_PRIVATE_KEY_PATH: '/fake/key.pem', XYP_CITIZEN_WSDL_URL: `http://127.0.0.1:${wsdlPort}/citizen?WSDL`, XYP_META_WSDL_URL: `http://127.0.0.1:${wsdlPort}/meta?WSDL`, XYP_TIMEOUT_MS: String(opts.timeoutMs ?? 3000),
    ...(opts.override ? { XYP_CITIZEN_ENDPOINT_URL: `http://127.0.0.1:${soapPort}/citizen`, XYP_META_ENDPOINT_URL: `http://127.0.0.1:${soapPort}/meta` } : {}), ...opts.env,
  };
  const client = new RealXypClient({ env, readFile: () => Buffer.from(keyPem), now: opts.clock });
  return { client, behavior, seen, seenOtp, wsdlHits: () => wsdlHits, metaWsdlHits: () => metaWsdlHits, otherHits: () => otherHits };
}
const fault = (text: string) => { throw { Fault: { faultcode: 'soap:Server', faultstring: text } }; };

describe('RealXypClient.getCitizen — амжилт', () => {
  it('регистр + иргэний кодоор WS100101 дуудаж XypCitizen болгоно', async () => {
    const h = await start();
    const c = await h.client.getCitizen(REG, OTP);
    expect(c).toMatchObject({ registerNo: REG, customerType: 'INDIVIDUAL', firstName: 'Бат', lastName: 'Доржийн', gender: 'MALE', birthDate: '1990-01-01', civilId: '12345678' });
    expect(c!.address).toEqual({ province: 'Улаанбаатар', district: 'Сүхбаатар', khoroo: '3-р хороо', detail: 'Энхтайвны өргөн чөлөө, 12' });
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]!.regnum).toBe(REG);
    expect(JSON.stringify(c)).not.toContain('IMAGE-BASE64-SECRET');
  });

  it('accessToken, timeStamp, signature HTTP header-ууд явж, гарын үсэг нийтийн түлхүүрээр баталгаажна', async () => {
    const h = await start({ clock: () => 1_700_000_000_500 });
    await h.client.getCitizen(REG, OTP);
    const hd = h.seen[0]!.headers;
    expect(hd.accesstoken).toBe(TOKEN);
    expect(hd.timestamp).toBe('1700000000');
    expect(verifies(hd.timestamp as string, hd.signature as string)).toBe(true);
  });

  it('дуудлага бүр шинэ timeStamp-ээр дахин гарын үсэг зурна; WSDL-ийг НЭГ л удаа татна (gsb шиг дуудлага бүрт биш)', async () => {
    let t = 1_700_000_000_000;
    const h = await start({ clock: () => (t += 1000) });
    await h.client.getCitizen(REG, OTP);
    await h.client.getCitizen(REG, OTP);
    expect(h.wsdlHits()).toBe(1);
    const [a, b] = h.seen.map((s) => s.headers);
    expect(a!.timestamp).not.toBe(b!.timestamp);
    expect(verifies(a!.timestamp as string, a!.signature as string)).toBe(true);
    expect(verifies(b!.timestamp as string, b!.signature as string)).toBe(true);
  });

  it('зэрэг дуудлагууд өөр өөрийн header-тэй (клиентийн төлөв хуваалцахгүй)', async () => {
    let t = 1_700_000_000_000;
    const h = await start({ clock: () => (t += 1000) });
    await Promise.all([h.client.getCitizen(REG, OTP), h.client.getCitizen(REG, OTP), h.client.getCitizen(REG, OTP)]);
    expect(h.seen).toHaveLength(3);
    expect(new Set(h.seen.map((s) => s.headers.timestamp)).size).toBe(3);
    for (const s of h.seen) expect(verifies(s.headers.timestamp as string, s.headers.signature as string)).toBe(true);
  });
});

describe('RealXypClient.getCitizen — олдсонгүй / алдаа', () => {
  it.each([['SOAP fault «олдсонгүй»', () => fault('Иргэн олдсонгүй')], ['SOAP fault «бүртгэлгүй»', () => fault('Бүртгэлгүй регистр')]])('%s → null', async (_l, respond) => {
    const h = await start();
    h.behavior.respond = respond;
    expect(await h.client.getCitizen(REG, OTP)).toBeNull();
  });

  it('resultCode≠0 + «олдсонгүй» мессеж → null; response хоосон → null', async () => {
    const h = await start();
    h.behavior.respond = () => ({ return: { resultCode: 1, resultMessage: 'Регистр олдсонгүй' } });
    expect(await h.client.getCitizen(REG, OTP)).toBeNull();
    h.behavior.respond = () => ({ return: { resultCode: 0, resultMessage: 'ok' } });
    expect(await h.client.getCitizen(REG, OTP)).toBeNull();
  });

  it('мессеж нь КОДТОЙ холбоотой fault / resultCode≠0 (OTP код буруу, код хугацаа дууссан) → XypOtpRejectedError', async () => {
    const h = await start();
    h.behavior.respond = () => fault('OTP код буруу байна');
    await expect(h.client.getCitizen(REG, OTP)).rejects.toBeInstanceOf(XypOtpRejectedError);
    h.behavior.respond = () => ({ return: { resultCode: 5, resultMessage: 'Нэг удаагийн код хугацаа дууссан' } });
    await expect(h.client.getCitizen(REG, OTP)).rejects.toMatchObject({ name: 'XypOtpRejectedError', resultCode: 5 });
  });

  it.each([['Internal server error'], ['Invalid signature'], ['Алдаатай хүсэлт'], ['Access token expired'], ['Алдааны код 500: Системийн алдаа']])(
    'кодтой холбоогүй fault %j (ХУР-ын доголдол, token / гарын үсгийн алдаа) → XypUnavailableError (faultCode-той), код буруу гэж ХЭЛЭХГҮЙ', async (text) => {
      const h = await start();
      h.behavior.respond = () => fault(text);
      const err = (await h.client.getCitizen(REG, OTP).catch((e) => e)) as XypUnavailableError & { faultCode?: string };
      expect(err).toBeInstanceOf(XypUnavailableError);
      expect(err).not.toBeInstanceOf(XypOtpRejectedError);
      expect(err.faultCode).toMatch(/Server/);
      h.behavior.respond = () => ({ return: { resultCode: 500, resultMessage: text } });
      const byCode = (await h.client.getCitizen(REG, OTP).catch((e) => e)) as XypUnavailableError & { resultCode?: number };
      expect(byCode).toBeInstanceOf(XypUnavailableError);
      expect(byCode.resultCode).toBe(500);
    });

  it('хоосон / танигдахгүй хариу (resultCode, resultMessage, response ямар ч талбаргүй) → XypUnavailableError, «олдсонгүй» БИШ', async () => {
    const h = await start();
    h.behavior.respond = () => ({});
    await expect(h.client.getCitizen(REG, OTP)).rejects.toBeInstanceOf(XypUnavailableError);
    h.behavior.respond = () => ({ return: {} });
    await expect(h.client.getCitizen(REG, OTP)).rejects.toBeInstanceOf(XypUnavailableError);
  });

  it('нэргүй / хэлбэр буруу хариу → XypUnavailableError', async () => {
    const h = await start();
    h.behavior.respond = () => citizen({ firstname: undefined });
    await expect(h.client.getCitizen(REG, OTP)).rejects.toBeInstanceOf(XypUnavailableError);
  });

  it('timeout → XypUnavailableError, дахин илгээхгүй (нэг л хүсэлт)', async () => {
    const h = await start({ timeoutMs: 100 });
    h.behavior.respond = () => new Promise((r) => setTimeout(() => r(citizen()), 600));
    await expect(h.client.getCitizen(REG, OTP)).rejects.toBeInstanceOf(XypUnavailableError);
    expect(h.seen).toHaveLength(1);
  });

  it('WSDL түр алдаатай (500) бол Unavailable, ДАРААГИЙН дуудлага дахин оролдож амжилттай болно (алдааг cache хийхгүй)', async () => {
    const h = await start();
    h.behavior.wsdlStatus = [500];
    await expect(h.client.getCitizen(REG, OTP)).rejects.toBeInstanceOf(XypUnavailableError);
    expect(await h.client.getCitizen(REG, OTP)).toMatchObject({ firstName: 'Бат' });
    expect(h.wsdlHits()).toBe(2);
  });

  it('холбогдох боломжгүй хост (холболт татгалзсан) → XypUnavailableError', async () => {
    const h = await start({ env: { XYP_CITIZEN_WSDL_URL: 'http://127.0.0.1:1/citizen?WSDL' } });
    await expect(h.client.getCitizen(REG, OTP)).rejects.toBeInstanceOf(XypUnavailableError);
  });

  it('алдааны мессеж регистр, token, зураг, vendor-ийн текстийг агуулахгүй', async () => {
    const h = await start();
    h.behavior.respond = () => fault(`Internal error for ${REG} ${TOKEN}`);
    const err = await h.client.getCitizen(REG, OTP).catch((e) => e as Error);
    expect((err as Error).message).not.toContain(REG);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).not.toContain('Internal error');
  });
});

// Аюулгүй байдлын шүүлт: WSDL-ийн зарласан endpoint нь нууц header (accessToken, гарын үсэг) ба регистрийг хүлээн авна → http эсвэл өөр хост руу ЯВУУЛАХГҮЙ, redirect дагахгүй.
describe('RealXypClient — endpoint ба redirect хамгаалалт', () => {
  it('WSDL-ийн зарласан endpoint нь WSDL-ийн хостоос ӨӨР бол татгалзаж, нэг ч хүсэлт явуулахгүй (IntegrationNotConfiguredError)', async () => {
    const h = await start({ declaredHost: 'localhost' });
    await expect(h.client.getCitizen(REG, OTP)).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    expect(h.seen).toHaveLength(0);
  });

  it('production-д WSDL-ийн endpoint http бол (хост ижил ч) татгалзана', async () => {
    const h = await start({ env: { NODE_ENV: 'production' } });
    await expect(h.client.getCitizen(REG, OTP)).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    expect(h.seen).toHaveLength(0);
  });

  it('татгалзсан endpoint-ийн алдаа нууц, регистр, хостыг агуулахгүй', async () => {
    const h = await start({ declaredHost: 'localhost' });
    const err = (await h.client.getCitizen(REG, OTP).catch((e) => e)) as Error;
    for (const secret of [TOKEN, REG, 'localhost']) expect(err.message).not.toContain(secret);
    expect(err.message).toContain('XYP_CITIZEN_ENDPOINT_URL');
  });

  it('XYP_CITIZEN_ENDPOINT_URL тохируулсан бол WSDL-ийн зарласан хаягийг үл хамааран тэр рүү дуудна', async () => {
    const h = await start({ declared: 'dead', override: true });
    expect(await h.client.getCitizen(REG, OTP)).toMatchObject({ firstName: 'Бат' });
    expect(h.seen).toHaveLength(1);
  });

  it('endpoint татгалзсаны дараа алдааг cache хийхгүй: тохиргоо засагдвал (өөр клиент) ажиллана', async () => {
    const bad = await start({ declaredHost: 'localhost' });
    await expect(bad.client.getCitizen(REG, OTP)).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    const ok = await start();
    expect(await ok.client.getCitizen(REG, OTP)).toMatchObject({ firstName: 'Бат' });
  });

  it('WSDL татахад redirect (302) ирвэл ДАГАХГҮЙ: Unavailable, зорилтот сервер 0 хүсэлт', async () => {
    const h = await start({ wsdlRedirect: true });
    await expect(h.client.getCitizen(REG, OTP)).rejects.toBeInstanceOf(XypUnavailableError);
    expect(h.otherHits()).toBe(0);
  });

  it('SOAP endpoint redirect (307) илгээвэл ДАГАХГҮЙ: Unavailable, зорилтот сервер 0 хүсэлт (header, регистр дамжихгүй)', async () => {
    const h = await start({ declared: 'redirector' });
    await expect(h.client.getCitizen(REG, OTP)).rejects.toBeInstanceOf(XypUnavailableError);
    expect(h.otherHits()).toBe(0);
    expect(h.seen).toHaveLength(0);
  });
});

// Review M3: «олдсонгүй»-г ЗӨВХӨН жинхэнэ SOAP fault-ийн faultstring-ээс таньна. Ерөнхий «алдаатай хүсэлт» (буруу token / гарын үсэг ч байж болно) ба
// сүлжээ/HTTP алдаа нь «иргэн байхгүй» БИШ — эс бөгөөс тохиргооны алдаа ажилтанд залилангийн дохио мэт харагдана.
describe('isXypNotFoundFault', () => {
  const faultOf = (text: string) => ({ message: 'soap fault', root: { Envelope: { Body: { Fault: { faultstring: text } } } } });
  it.each([['Иргэн олдсонгүй'], ['Бүртгэлгүй регистр'], ['Citizen NOT FOUND']])('SOAP fault %j → true', (text) => {
    expect(isXypNotFoundFault(faultOf(text))).toBe(true);
  });
  it.each([['Алдаатай хүсэлт'], ['Invalid signature'], ['Internal error'], ['']])('SOAP fault %j → false (олдсонгүй гэж таамаглахгүй)', (text) => {
    expect(isXypNotFoundFault(faultOf(text))).toBe(false);
  });
  it.each([[new Error('Иргэн олдсонгүй')], [{ message: 'getaddrinfo ENOTFOUND not found' }], [null], [undefined], ['олдсонгүй']])('fault бүтэцгүй алдаа %j (сүлжээ, HTTP, тодорхойгүй) → false', (e) => {
    expect(isXypNotFoundFault(e)).toBe(false);
  });
});

// Код өгсний дараа ХУР-ын fault / resultMessage-ийг «код буруу» гэж ангилах цорын ганц дүрэм. Vendor-ийн алдааны текстийн хүснэгт repo-д байхгүй (VPN-ээр баталгаажуулна);
// ТАНИГДААГҮЙ нь «код буруу» БИШ: ХУР-ын доголдол, token / гарын үсгийн алдаа нь иргэнд дахин SMS илгээлгэж, аудитад хуурамч «код татгалзсан» бичлэг үүсгэх ёсгүй.
describe('isXypCodeRejection', () => {
  it.each([['OTP код буруу байна'], ['Invalid OTP'], ['Нэг удаагийн код хугацаа дууссан'], ['Код буруу'], ['verification code expired'], ['The code is wrong'], ['Буруу код оруулсан байна']])('%j → true', (text) => {
    expect(isXypCodeRejection(text)).toBe(true);
  });
  it.each([['Internal server error'], ['Invalid signature'], ['Access token expired'], ['Алдаатай хүсэлт'], ['Алдааны код 500: Системийн алдаа'], ['Service unavailable'], ['']])('%j → false', (text) => {
    expect(isXypCodeRejection(text)).toBe(false);
  });
});

describe('RealXypClient — ерөнхий «алдаатай хүсэлт» fault', () => {
  it('«Алдаатай хүсэлт» SOAP fault → XypUnavailableError (null/404 БИШ; кодыг буруу гэж ч үзэхгүй — буруу token / гарын үсэг байж болно)', async () => {
    const h = await start();
    h.behavior.respond = () => fault('Алдаатай хүсэлт');
    await expect(h.client.getCitizen(REG, OTP)).rejects.toBeInstanceOf(XypUnavailableError);
  });
  it('resultCode≠0 + «Алдаатай хүсэлт» → XypUnavailableError', async () => {
    const h = await start();
    h.behavior.respond = () => ({ return: { resultCode: 3, resultMessage: 'Алдаатай хүсэлт' } });
    await expect(h.client.getCitizen(REG, OTP)).rejects.toBeInstanceOf(XypUnavailableError);
  });
});

describe('RealXypClient — fail-closed', () => {
  it('хуулийн этгээдийн регистр (7 орон) → IntegrationNotImplementedError, сүлжээний дуудлагагүй', async () => {
    const h = await start();
    await expect(h.client.getCitizen('1234567', OTP)).rejects.toBeInstanceOf(IntegrationNotImplementedError);
    expect(h.seen).toHaveLength(0);
    expect(h.wsdlHits()).toBe(0);
  });

  it('getAssets / getProperty → IntegrationNotImplementedError (gsb-д лавлагаа байхгүй)', async () => {
    const h = await start();
    await expect(h.client.getAssets(REG)).rejects.toBeInstanceOf(IntegrationNotImplementedError);
    await expect(h.client.getProperty('P-1')).rejects.toBeInstanceOf(IntegrationNotImplementedError);
    expect(h.wsdlHits()).toBe(0);
  });

  it('тохиргоо дутуу (production биш real) → IntegrationNotConfiguredError, сүлжээний дуудлагагүй', async () => {
    const h = await start({ env: { XYP_ACCESS_TOKEN: '' } });
    await expect(h.client.getCitizen(REG, OTP)).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    expect(h.wsdlHits()).toBe(0);
  });
});

// Иргэний зөвшөөрөл: код нь иргэний ХУР-д бүртгэлтэй утсанд очно; код зөв үед л WS100101 хариулна. Код нь нууц: алдаа, лог, мессежэд орохгүй.
describe('RealXypClient.getCitizen — иргэний код (auth.citizen.otp)', () => {
  const fingerprintOf = (fp: unknown): string => (Buffer.isBuffer(fp) ? fp.toString() : Buffer.from(String(fp), 'base64').toString());

  it('WS100101-д auth.citizen.{regnum, otp, fingerprint}, auth.operator.otp=0 ба regnum явна', async () => {
    const h = await start();
    await h.client.getCitizen(REG, OTP);
    const r = h.seen[0]!.request;
    expect(r.regnum).toBe(REG);
    expect(r.auth.citizen.regnum).toBe(REG);
    expect(Number(r.auth.citizen.otp)).toBe(123456);
    expect(fingerprintOf(r.auth.citizen.fingerprint)).toBe('*** NO ACCESS ***'); // vendor demo (OTPApprove.py)-ийн хөрөнгө-оруулалтгүй placeholder
    expect(Number(r.auth.operator.otp)).toBe(0);
    expect(r.auth.operator.regnum).toBeUndefined();
  });

  it('код int болж явна (vendor int хүлээн авдаг): тэгээр эхэлсэн "012345" → 12345', async () => {
    const h = await start();
    await h.client.getCitizen(REG, '012345');
    expect(Number(h.seen[0]!.request.auth.citizen.otp)).toBe(12345);
  });

  it.each([[''], ['123'], ['123456789'], ['12ab56'], [' 123456'], ['1e5']])('код %j буруу хэлбэртэй → XypOtpRejectedError, сүлжээний дуудлагагүй', async (bad) => {
    const h = await start();
    await expect(h.client.getCitizen(REG, bad)).rejects.toBeInstanceOf(XypOtpRejectedError);
    expect(h.wsdlHits()).toBe(0);
    expect(h.seen).toHaveLength(0);
  });

  it('ХУР fault-аар татгалзвал XypOtpRejectedError (faultCode-той — оношлоход); мессеж код, регистр, token, vendor текстийг агуулахгүй', async () => {
    const h = await start();
    h.behavior.respond = () => fault(`Invalid OTP ${OTP} for ${REG} ${TOKEN}`);
    const err = (await h.client.getCitizen(REG, OTP).catch((e) => e)) as XypOtpRejectedError;
    expect(err).toBeInstanceOf(XypOtpRejectedError);
    expect(err.faultCode).toMatch(/Server/);
    for (const secret of [OTP, REG, TOKEN, 'Invalid OTP']) expect(err.message).not.toContain(secret);
  });

  it('«олдсонгүй» fault код өгсөн ч null (иргэн байхгүй), XypOtpRejectedError БИШ', async () => {
    const h = await start();
    h.behavior.respond = () => fault('Иргэн олдсонгүй');
    expect(await h.client.getCitizen(REG, OTP)).toBeNull();
  });

  it('сүлжээ / timeout / WSDL 500 → XypUnavailableError (кодыг буруу гэж ХЭЛЭХГҮЙ — иргэн шинэ код авах шаардлагагүй)', async () => {
    const t = await start({ timeoutMs: 100 });
    t.behavior.respond = () => new Promise((r) => setTimeout(() => r(citizen()), 600));
    await expect(t.client.getCitizen(REG, OTP)).rejects.toBeInstanceOf(XypUnavailableError);
    expect(t.seen).toHaveLength(1); // дахин илгээхгүй: нэг удаагийн код шатахгүй
    const w = await start();
    w.behavior.wsdlStatus = [500];
    await expect(w.client.getCitizen(REG, OTP)).rejects.toBeInstanceOf(XypUnavailableError);
    const d = await start({ env: { XYP_CITIZEN_WSDL_URL: 'http://127.0.0.1:1/citizen?WSDL' } });
    await expect(d.client.getCitizen(REG, OTP)).rejects.toBeInstanceOf(XypUnavailableError);
  });
});

describe('RealXypClient.requestCitizenOtp (WS100008, meta WSDL)', () => {
  it('иргэний БҮРТГЭЛТЭЙ утсанд (phoneNum=0) SMS-ээр, зөвхөн WS100101-д зориулж хүсч, нийтийн түлхүүрээр баталгаажих header-тэй → true; citizen service-д хүрэхгүй', async () => {
    const h = await start({ clock: () => 1_700_000_000_500 });
    expect(await h.client.requestCitizenOtp(REG)).toBe(true);
    expect(h.seen).toHaveLength(0);
    expect(h.seenOtp).toHaveLength(1);
    const r = h.seenOtp[0]!.request;
    expect(r.regnum).toBe(REG);
    expect(r.auth.citizen.regnum).toBe(REG);
    expect(Number(r.auth.citizen.otp)).toBe(0);
    expect(JSON.parse(r.jsonWSList)).toEqual([{ ws: 'WS100101_getCitizenIDCardInfo' }]); // хамгийн бага эрх: зөвхөн энэ үйлдэлд код хүчинтэй
    expect([r.isSms, r.isApp, r.isEmail, r.isKiosk, r.phoneNum].map(Number)).toEqual([1, 0, 0, 0, 0]);
    const hd = h.seenOtp[0]!.headers;
    expect(hd.accesstoken).toBe(TOKEN);
    expect(hd.timestamp).toBe('1700000000');
    expect(verifies(hd.timestamp as string, hd.signature as string)).toBe(true);
  });

  it.each([['resultCode 0', { return: { resultCode: 0, resultMessage: 'ok' } }], ['resultCode-гүй амжилттай хариу (gsb-тэй ижил)', { return: { resultMessage: 'sent' } }]])('%s → true', async (_l, reply) => {
    const h = await start();
    h.behavior.otpRespond = () => reply;
    expect(await h.client.requestCitizenOtp(REG)).toBe(true);
  });

  it.each([['SOAP fault «олдсонгүй»', () => fault('Иргэн олдсонгүй')], ['resultCode≠0 + «бүртгэлгүй»', () => ({ return: { resultCode: 2, resultMessage: 'Регистр бүртгэлгүй' } })]])('%s → false (иргэн олдсонгүй)', async (_l, respond) => {
    const h = await start();
    h.behavior.otpRespond = respond;
    expect(await h.client.requestCitizenOtp(REG)).toBe(false);
  });

  it('танигдаагүй fault / resultCode≠0 → XypUnavailableError (SMS явсан эсэх тодорхойгүй; «олдсонгүй» гэж таамаглахгүй)', async () => {
    const h = await start();
    h.behavior.otpRespond = () => fault('Internal server error');
    await expect(h.client.requestCitizenOtp(REG)).rejects.toBeInstanceOf(XypUnavailableError);
    h.behavior.otpRespond = () => ({ return: { resultCode: 500, resultMessage: 'Системийн алдаа' } });
    await expect(h.client.requestCitizenOtp(REG)).rejects.toBeInstanceOf(XypUnavailableError);
  });

  it('timeout → XypUnavailableError, ДАХИН илгээхгүй (иргэнд SMS давхар явахгүй): нэг л хүсэлт', async () => {
    const h = await start({ timeoutMs: 100 });
    h.behavior.otpRespond = () => new Promise((r) => setTimeout(() => r({ return: { resultCode: 0 } }), 600));
    await expect(h.client.requestCitizenOtp(REG)).rejects.toBeInstanceOf(XypUnavailableError);
    expect(h.seenOtp).toHaveLength(1);
  });

  it('meta WSDL-ийг нэг л удаа татаж cache хийнэ; citizen WSDL-ийг татахгүй', async () => {
    const h = await start();
    await h.client.requestCitizenOtp(REG);
    await h.client.requestCitizenOtp(REG);
    expect(h.metaWsdlHits()).toBe(1);
    expect(h.wsdlHits()).toBe(0);
  });

  it('хуулийн этгээдийн регистр (7 орон) → IntegrationNotImplementedError, сүлжээний дуудлагагүй', async () => {
    const h = await start();
    await expect(h.client.requestCitizenOtp('1234567')).rejects.toBeInstanceOf(IntegrationNotImplementedError);
    expect(h.seenOtp).toHaveLength(0);
    expect(h.metaWsdlHits()).toBe(0);
  });

  it('тохиргоо дутуу → IntegrationNotConfiguredError, сүлжээний дуудлагагүй', async () => {
    const h = await start({ env: { XYP_ACCESS_TOKEN: '' } });
    await expect(h.client.requestCitizenOtp(REG)).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    expect(h.metaWsdlHits()).toBe(0);
  });

  it('meta WSDL-ийн зарласан endpoint өөр хост бол татгалзаж, нэг ч хүсэлт явуулахгүй; алдаа XYP_META_ENDPOINT_URL нэрийг заана (хост, нууц, регистр биш)', async () => {
    const h = await start({ declaredHost: 'localhost' });
    const err = (await h.client.requestCitizenOtp(REG).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(IntegrationNotConfiguredError);
    expect(err.message).toContain('XYP_META_ENDPOINT_URL');
    for (const secret of [TOKEN, REG, 'localhost']) expect(err.message).not.toContain(secret);
    expect(h.seenOtp).toHaveLength(0);
  });

  it('production-д meta endpoint http бол татгалзана; XYP_META_ENDPOINT_URL тохируулсан бол WSDL-ийн хаягийг үл хамааран тэр рүү дуудна', async () => {
    const prod = await start({ env: { NODE_ENV: 'production' } });
    await expect(prod.client.requestCitizenOtp(REG)).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    const ov = await start({ declared: 'dead', override: true });
    expect(await ov.client.requestCitizenOtp(REG)).toBe(true);
  });

  it('алдааны мессеж регистр, token, vendor-ийн текстийг агуулахгүй', async () => {
    const h = await start();
    h.behavior.otpRespond = () => fault(`Internal error for ${REG} ${TOKEN}`);
    const err = (await h.client.requestCitizenOtp(REG).catch((e) => e)) as Error;
    for (const secret of [REG, TOKEN, 'Internal error']) expect(err.message).not.toContain(secret);
  });
});
