import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as soap from 'soap';
import { afterEach, describe, expect, it } from 'vitest';
import { IntegrationNotConfiguredError, IntegrationNotImplementedError } from '../errors';
import { isXypNotFoundFault, RealXypClient } from './real-xyp.client';
import { XypUnavailableError } from './xyp.client';

// Бодит `soap` номын сангаар локал SOAP серверт (127.0.0.1) хийсэн wire-level тест. Бодит ХУР-т хандаагүй.
// АНХААР: WSDL нь ШИНЖИЛГЭЭНИЙ ЗОРИУЛАЛТТАЙ загвар. Нотлогдсон: үйлдлийн нэр WS100101_getCitizenIDCardInfo, хариуны response/resultCode/resultMessage,
// гарын үсгийн header. ТААМАГЛАЛ (бодит WSDL-ээр шалгана, VPN хэрэгтэй): хүсэлтийн `request` wrapper, хариуны `return` wrapper.
const TOKEN = 'TEST-ACCESS-TOKEN';
const REG = 'УБ90010112';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const verifies = (ts: string, sig: string): boolean => createVerify('RSA-SHA256').update(`${TOKEN}.${ts}`).verify(rsa.publicKey, sig, 'base64');

const DATA_FIELDS = ['firstname', 'lastname', 'gender', 'birthDateAsText', 'civilId', 'aimagCityName', 'soumDistrictName', 'bagKhorooName', 'addressStreetName', 'addressDetail', 'addressDoor', 'addressApartmentName', 'passportAddress', 'image'];
const wsdl = (soapPort: number, host = '127.0.0.1'): string => `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:test:citizen" targetNamespace="urn:test:citizen" name="CitizenService">
  <types><xsd:schema targetNamespace="urn:test:citizen" elementFormDefault="unqualified">
    <xsd:element name="WS100101_getCitizenIDCardInfo"><xsd:complexType><xsd:sequence><xsd:element name="request" type="tns:CitizenRequest"/></xsd:sequence></xsd:complexType></xsd:element>
    <xsd:element name="WS100101_getCitizenIDCardInfoResponse"><xsd:complexType><xsd:sequence><xsd:element name="return" type="tns:CitizenResult"/></xsd:sequence></xsd:complexType></xsd:element>
    <xsd:complexType name="CitizenRequest"><xsd:sequence><xsd:element name="regnum" type="xsd:string"/></xsd:sequence></xsd:complexType>
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

const citizen = (over: Record<string, unknown> = {}) => ({
  return: { resultCode: 0, resultMessage: 'Амжилттай', response: {
    firstname: 'Бат', lastname: 'Доржийн', gender: 'Эрэгтэй', birthDateAsText: '1990-01-01 00:00', civilId: '12345678', aimagCityName: 'Улаанбаатар', soumDistrictName: 'Сүхбаатар',
    bagKhorooName: '3-р хороо', addressStreetName: 'Энхтайвны өргөн чөлөө', addressDetail: '12', image: 'IMAGE-BASE64-SECRET', ...over,
  } },
});

interface Behavior { respond: (regnum: string) => unknown | Promise<unknown>; wsdlStatus: number[] }
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
  const behavior: Behavior = { respond: () => citizen(), wsdlStatus: [] };
  const seen: Array<{ headers: IncomingHttpHeaders; regnum: string }> = [];
  const soapServer = createServer();
  const soapPort = await listen(soapServer);
  soap.listen(soapServer, '/citizen', {
    CitizenService: { CitizenPort: {
      WS100101_getCitizenIDCardInfo: (args: { request: { regnum: string } }, _cb: unknown, _h: unknown, req: { headers: IncomingHttpHeaders }) => {
        seen.push({ headers: req.headers, regnum: args.request.regnum });
        return behavior.respond(args.request.regnum);
      },
    } },
  }, wsdl(soapPort));
  // «Өөр» сервер: redirect-ийн зорилтот. Нэг ч хүсэлт хүлээн авч ЯВАХГҮЙ (redirect дагахгүй).
  let otherHits = 0;
  const other = createServer((_req, res) => { otherHits++; res.writeHead(200); res.end('x'); });
  const otherPort = await listen(other);
  const redirector = createServer((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${otherPort}/citizen` }); res.end(); });
  const redirectorPort = await listen(redirector);
  const declaredPort = opts.declared === 'dead' ? 1 : opts.declared === 'redirector' ? redirectorPort : soapPort;
  let wsdlHits = 0;
  const wsdlServer = createServer((_req, res) => {
    wsdlHits++;
    if (opts.wsdlRedirect) { res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/wsdl` }); res.end(); return; }
    const status = behavior.wsdlStatus.shift() ?? 200;
    res.writeHead(status, { 'content-type': 'text/xml' });
    res.end(status === 200 ? wsdl(declaredPort, opts.declaredHost) : 'boom');
  });
  const wsdlPort = await listen(wsdlServer);
  cleanups.push(() => close(soapServer), () => close(wsdlServer), () => close(other), () => close(redirector));
  const env = {
    INTEGRATION_MODE: 'real', XYP_ACCESS_TOKEN: TOKEN, XYP_PRIVATE_KEY_PATH: '/fake/key.pem', XYP_CITIZEN_WSDL_URL: `http://127.0.0.1:${wsdlPort}/citizen?WSDL`, XYP_TIMEOUT_MS: String(opts.timeoutMs ?? 3000),
    ...(opts.override ? { XYP_CITIZEN_ENDPOINT_URL: `http://127.0.0.1:${soapPort}/citizen` } : {}), ...opts.env,
  };
  const client = new RealXypClient({ env, readFile: () => Buffer.from(keyPem), now: opts.clock });
  return { client, behavior, seen, wsdlHits: () => wsdlHits, otherHits: () => otherHits };
}
const fault = (text: string) => { throw { Fault: { faultcode: 'soap:Server', faultstring: text } }; };

describe('RealXypClient.getCitizen — амжилт', () => {
  it('регистрээр WS100101 дуудаж XypCitizen болгоно; хүсэлтэд зөвхөн regnum явна', async () => {
    const h = await start();
    const c = await h.client.getCitizen(REG);
    expect(c).toMatchObject({ registerNo: REG, customerType: 'INDIVIDUAL', firstName: 'Бат', lastName: 'Доржийн', gender: 'MALE', birthDate: '1990-01-01', civilId: '12345678' });
    expect(c!.address).toEqual({ province: 'Улаанбаатар', district: 'Сүхбаатар', khoroo: '3-р хороо', detail: 'Энхтайвны өргөн чөлөө, 12' });
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]!.regnum).toBe(REG);
    expect(JSON.stringify(c)).not.toContain('IMAGE-BASE64-SECRET');
  });

  it('accessToken, timeStamp, signature HTTP header-ууд явж, гарын үсэг нийтийн түлхүүрээр баталгаажна', async () => {
    const h = await start({ clock: () => 1_700_000_000_500 });
    await h.client.getCitizen(REG);
    const hd = h.seen[0]!.headers;
    expect(hd.accesstoken).toBe(TOKEN);
    expect(hd.timestamp).toBe('1700000000');
    expect(verifies(hd.timestamp as string, hd.signature as string)).toBe(true);
  });

  it('дуудлага бүр шинэ timeStamp-ээр дахин гарын үсэг зурна; WSDL-ийг НЭГ л удаа татна (gsb шиг дуудлага бүрт биш)', async () => {
    let t = 1_700_000_000_000;
    const h = await start({ clock: () => (t += 1000) });
    await h.client.getCitizen(REG);
    await h.client.getCitizen(REG);
    expect(h.wsdlHits()).toBe(1);
    const [a, b] = h.seen.map((s) => s.headers);
    expect(a!.timestamp).not.toBe(b!.timestamp);
    expect(verifies(a!.timestamp as string, a!.signature as string)).toBe(true);
    expect(verifies(b!.timestamp as string, b!.signature as string)).toBe(true);
  });

  it('зэрэг дуудлагууд өөр өөрийн header-тэй (клиентийн төлөв хуваалцахгүй)', async () => {
    let t = 1_700_000_000_000;
    const h = await start({ clock: () => (t += 1000) });
    await Promise.all([h.client.getCitizen(REG), h.client.getCitizen(REG), h.client.getCitizen(REG)]);
    expect(h.seen).toHaveLength(3);
    expect(new Set(h.seen.map((s) => s.headers.timestamp)).size).toBe(3);
    for (const s of h.seen) expect(verifies(s.headers.timestamp as string, s.headers.signature as string)).toBe(true);
  });
});

describe('RealXypClient.getCitizen — олдсонгүй / алдаа', () => {
  it.each([['SOAP fault «олдсонгүй»', () => fault('Иргэн олдсонгүй')], ['SOAP fault «бүртгэлгүй»', () => fault('Бүртгэлгүй регистр')]])('%s → null', async (_l, respond) => {
    const h = await start();
    h.behavior.respond = respond;
    expect(await h.client.getCitizen(REG)).toBeNull();
  });

  it('resultCode≠0 + «олдсонгүй» мессеж → null; response хоосон → null', async () => {
    const h = await start();
    h.behavior.respond = () => ({ return: { resultCode: 1, resultMessage: 'Регистр олдсонгүй' } });
    expect(await h.client.getCitizen(REG)).toBeNull();
    h.behavior.respond = () => ({ return: { resultCode: 0, resultMessage: 'ok' } });
    expect(await h.client.getCitizen(REG)).toBeNull();
  });

  it('танигдаагүй fault / resultCode≠0 → XypUnavailableError (код хүснэгтгүй тул «олдсонгүй» гэж таамаглахгүй)', async () => {
    const h = await start();
    h.behavior.respond = () => fault('Internal server error');
    await expect(h.client.getCitizen(REG)).rejects.toBeInstanceOf(XypUnavailableError);
    h.behavior.respond = () => ({ return: { resultCode: 500, resultMessage: 'Системийн алдаа' } });
    await expect(h.client.getCitizen(REG)).rejects.toBeInstanceOf(XypUnavailableError);
  });

  it('хоосон / танигдахгүй хариу (resultCode, resultMessage, response ямар ч талбаргүй) → XypUnavailableError, «олдсонгүй» БИШ', async () => {
    const h = await start();
    h.behavior.respond = () => ({});
    await expect(h.client.getCitizen(REG)).rejects.toBeInstanceOf(XypUnavailableError);
    h.behavior.respond = () => ({ return: {} });
    await expect(h.client.getCitizen(REG)).rejects.toBeInstanceOf(XypUnavailableError);
  });

  it('нэргүй / хэлбэр буруу хариу → XypUnavailableError', async () => {
    const h = await start();
    h.behavior.respond = () => citizen({ firstname: undefined });
    await expect(h.client.getCitizen(REG)).rejects.toBeInstanceOf(XypUnavailableError);
  });

  it('timeout → XypUnavailableError, дахин илгээхгүй (нэг л хүсэлт)', async () => {
    const h = await start({ timeoutMs: 100 });
    h.behavior.respond = () => new Promise((r) => setTimeout(() => r(citizen()), 600));
    await expect(h.client.getCitizen(REG)).rejects.toBeInstanceOf(XypUnavailableError);
    expect(h.seen).toHaveLength(1);
  });

  it('WSDL түр алдаатай (500) бол Unavailable, ДАРААГИЙН дуудлага дахин оролдож амжилттай болно (алдааг cache хийхгүй)', async () => {
    const h = await start();
    h.behavior.wsdlStatus = [500];
    await expect(h.client.getCitizen(REG)).rejects.toBeInstanceOf(XypUnavailableError);
    expect(await h.client.getCitizen(REG)).toMatchObject({ firstName: 'Бат' });
    expect(h.wsdlHits()).toBe(2);
  });

  it('холбогдох боломжгүй хост (холболт татгалзсан) → XypUnavailableError', async () => {
    const h = await start({ env: { XYP_CITIZEN_WSDL_URL: 'http://127.0.0.1:1/citizen?WSDL' } });
    await expect(h.client.getCitizen(REG)).rejects.toBeInstanceOf(XypUnavailableError);
  });

  it('алдааны мессеж регистр, token, зураг, vendor-ийн текстийг агуулахгүй', async () => {
    const h = await start();
    h.behavior.respond = () => fault(`Internal error for ${REG} ${TOKEN}`);
    const err = await h.client.getCitizen(REG).catch((e) => e as Error);
    expect((err as Error).message).not.toContain(REG);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).not.toContain('Internal error');
  });
});

// Аюулгүй байдлын шүүлт: WSDL-ийн зарласан endpoint нь нууц header (accessToken, гарын үсэг) ба регистрийг хүлээн авна → http эсвэл өөр хост руу ЯВУУЛАХГҮЙ, redirect дагахгүй.
describe('RealXypClient — endpoint ба redirect хамгаалалт', () => {
  it('WSDL-ийн зарласан endpoint нь WSDL-ийн хостоос ӨӨР бол татгалзаж, нэг ч хүсэлт явуулахгүй (IntegrationNotConfiguredError)', async () => {
    const h = await start({ declaredHost: 'localhost' });
    await expect(h.client.getCitizen(REG)).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    expect(h.seen).toHaveLength(0);
  });

  it('production-д WSDL-ийн endpoint http бол (хост ижил ч) татгалзана', async () => {
    const h = await start({ env: { NODE_ENV: 'production' } });
    await expect(h.client.getCitizen(REG)).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    expect(h.seen).toHaveLength(0);
  });

  it('татгалзсан endpoint-ийн алдаа нууц, регистр, хостыг агуулахгүй', async () => {
    const h = await start({ declaredHost: 'localhost' });
    const err = (await h.client.getCitizen(REG).catch((e) => e)) as Error;
    for (const secret of [TOKEN, REG, 'localhost']) expect(err.message).not.toContain(secret);
    expect(err.message).toContain('XYP_CITIZEN_ENDPOINT_URL');
  });

  it('XYP_CITIZEN_ENDPOINT_URL тохируулсан бол WSDL-ийн зарласан хаягийг үл хамааран тэр рүү дуудна', async () => {
    const h = await start({ declared: 'dead', override: true });
    expect(await h.client.getCitizen(REG)).toMatchObject({ firstName: 'Бат' });
    expect(h.seen).toHaveLength(1);
  });

  it('endpoint татгалзсаны дараа алдааг cache хийхгүй: тохиргоо засагдвал (өөр клиент) ажиллана', async () => {
    const bad = await start({ declaredHost: 'localhost' });
    await expect(bad.client.getCitizen(REG)).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    const ok = await start();
    expect(await ok.client.getCitizen(REG)).toMatchObject({ firstName: 'Бат' });
  });

  it('WSDL татахад redirect (302) ирвэл ДАГАХГҮЙ: Unavailable, зорилтот сервер 0 хүсэлт', async () => {
    const h = await start({ wsdlRedirect: true });
    await expect(h.client.getCitizen(REG)).rejects.toBeInstanceOf(XypUnavailableError);
    expect(h.otherHits()).toBe(0);
  });

  it('SOAP endpoint redirect (307) илгээвэл ДАГАХГҮЙ: Unavailable, зорилтот сервер 0 хүсэлт (header, регистр дамжихгүй)', async () => {
    const h = await start({ declared: 'redirector' });
    await expect(h.client.getCitizen(REG)).rejects.toBeInstanceOf(XypUnavailableError);
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

describe('RealXypClient — ерөнхий «алдаатай хүсэлт» fault', () => {
  it('«Алдаатай хүсэлт» SOAP fault → XypUnavailableError (null/404 БИШ)', async () => {
    const h = await start();
    h.behavior.respond = () => fault('Алдаатай хүсэлт');
    await expect(h.client.getCitizen(REG)).rejects.toBeInstanceOf(XypUnavailableError);
  });
  it('resultCode≠0 + «Алдаатай хүсэлт» → XypUnavailableError', async () => {
    const h = await start();
    h.behavior.respond = () => ({ return: { resultCode: 3, resultMessage: 'Алдаатай хүсэлт' } });
    await expect(h.client.getCitizen(REG)).rejects.toBeInstanceOf(XypUnavailableError);
  });
});

describe('RealXypClient — fail-closed', () => {
  it('хуулийн этгээдийн регистр (7 орон) → IntegrationNotImplementedError, сүлжээний дуудлагагүй', async () => {
    const h = await start();
    await expect(h.client.getCitizen('1234567')).rejects.toBeInstanceOf(IntegrationNotImplementedError);
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
    await expect(h.client.getCitizen(REG)).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    expect(h.wsdlHits()).toBe(0);
  });
});
