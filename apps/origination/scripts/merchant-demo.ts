/**
 * DEMO ONLY — Мерчант POS порталын локал демо сервер (gateway + origination нэг процесст).
 *
 * - санах ойн persistence (процесс дахин асахад өгөгдөл арилна), mock интеграци, OTP тогтмол `123456`;
 * - gateway-г дууриана: `demo_persona` cookie → GATEWAY_HEADERS (x-user-id, x-roles, …); клиентийн ирүүлсэн gateway толгойг ЯМАР Ч замд устгана;
 * - production-д ЭСВЭЛ INTEGRATION_MODE=real үед эхлэхээс татгалзана (config-ийн isProduction/readIntegrationMode-оор);
 * - зөвхөн loopback дээр сонсоно; DEMO_HOST өөр бол DEMO_ALLOW_REMOTE=1 заавал (+ чанга анхааруулга) — нэвтрэлтгүй ADMIN persona-г сүлжээнд нээхгүйн тулд;
 * - хэвлэх/өгөх URL нь `localhost` (вэб-ийн API суурь http://localhost:4000/api-тай cookie-ийн хост таарна).
 *
 * Ажиллуулах: `pnpm --filter @los/origination demo:merchant` → http://localhost:4000/demo
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HealthModule } from '@los/nest-common';
import { MerchantModule } from '../src/modules/merchant/merchant.module';
import { DEMO_OTP } from '../src/modules/merchant/integrations/otp/fixed-otp.generator';
import { Clock } from '../src/modules/merchant/ports';
import { LeaseService } from '../src/modules/merchant/services/lease.service';
import { DashboardService } from '../src/modules/merchant/services/dashboard.service';
import { MerchantService } from '../src/modules/merchant/services/merchant.service';
import { PlanService } from '../src/modules/merchant/services/plan.service';
import { DEMO_ORG_ID, DEMO_USERS, DemoClock, seedDemo } from '../src/modules/merchant/testing/seed-demo';
import { personasFor, type HeaderMap } from '../src/modules/merchant/testing/personas';
import { applyDemoIdentity, corsOrigins, demoRefusal, displayHost, hostPolicy } from '../src/modules/merchant/testing/demo-gateway';

const PORT = Number(process.env.DEMO_PORT ?? 4000);
const HOST = process.env.DEMO_HOST?.trim() || '127.0.0.1'; // анхдагч зөвхөн loopback; loopback биш бол DEMO_ALLOW_REMOTE=1 (hostPolicy)
const WEB_URL = (process.env.DEMO_WEB_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const COOKIE = 'demo_persona';

// @types/express суулгаагүй тул хамгийн бага хэлбэр.
interface Req { url?: string; method?: string; headers: Record<string, string | string[] | undefined> }
interface Res { statusCode: number; setHeader(name: string, value: string | string[]): unknown; end(body?: string): unknown }
type Next = () => void;
interface ExpressLike { use(fn: (req: Req, res: Res, next: Next) => void): void; get(path: string, fn: (req: Req, res: Res) => void): void }

type PersonaKey = 'cashier-1' | 'cashier-2' | 'merchant-admin' | 'lender-admin' | 'approver';
interface Persona { key: PersonaKey; label: string; hint: string; headers: HeaderMap; landing: string }

function refuseUnsafe(): void {
  const host = hostPolicy(HOST);
  const refusal = demoRefusal() ?? (host.allowed ? null : host.message);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  if (host.message) console.warn(`\n${'!'.repeat(78)}\n${host.message}\n${'!'.repeat(78)}\n`); // DEMO_ALLOW_REMOTE=1: чанга анхааруулга
}

refuseUnsafe(); // MerchantModule.register(memory) production-д өөрөө ч алдаа шиднэ; энд ойлгомжтой мессеж өгнө

// Нэг цаг: seed-д ухарч, дараа нь жинхэнэ цаг руу шилжинэ.
const clock = new DemoClock();

@Module({
  imports: [HealthModule.forService('origination'), MerchantModule.register({ persistence: 'memory', integrationMode: 'mock', overrides: [{ provide: Clock, useValue: clock }] })],
})
class DemoAppModule {}

function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const raw = Array.isArray(header) ? header.join(';') : (header ?? '');
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function buildPersonas(merchantId: string, storeA1: string, storeA2: string): Persona[] {
  const p = personasFor(merchantId, DEMO_ORG_ID);
  const merchantLanding = `${WEB_URL}/merchant`;
  return [
    { key: 'cashier-1', label: 'Кассир — Төв дэлгүүр', hint: 'Тэмүүлэл Дижитал, MERCHANT_STAFF (дэлгүүр 1)', headers: p.staff(storeA1, DEMO_USERS.cashier1), landing: merchantLanding },
    { key: 'cashier-2', label: 'Кассир — Салбар дэлгүүр', hint: 'Тэмүүлэл Дижитал, MERCHANT_STAFF (дэлгүүр 2)', headers: p.staff(storeA2, DEMO_USERS.cashier2), landing: merchantLanding },
    { key: 'merchant-admin', label: 'Мерчантын админ', hint: 'Тэмүүлэл Дижитал, MERCHANT_ADMIN', headers: p.merchantAdmin(DEMO_USERS.merchantAdmin), landing: merchantLanding },
    { key: 'lender-admin', label: 'Лизингийн байгууллага — админ', hint: 'ADMIN (мерчант, хөтөлбөр, тооцоо)', headers: p.lenderAdmin(DEMO_USERS.lenderAdmin), landing: `${WEB_URL}/settings/merchants` },
    { key: 'approver', label: 'Лизингийн байгууллага — шинжээч', hint: 'APPROVER (REFER хянах)', headers: p.approver(DEMO_USERS.approver), landing: `${WEB_URL}/los/pos-leases` },
  ];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function demoPage(personas: Persona[], current: string | undefined): string {
  const buttons = personas.map((p) => `<li><a class="btn${p.key === current ? ' on' : ''}" href="/demo/login/${p.key}"><b>${esc(p.label)}</b><span>${esc(p.hint)}</span></a></li>`).join('');
  return `<!doctype html><html lang="mn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>POS demo</title>
<style>:root{color-scheme:light dark;--bg:#fff;--fg:#14202b;--mut:#5b6b7a;--bd:#d5dde5;--acc:#0b5fff;--warn:#fff4d6;--warnfg:#6b4a00}
@media(prefers-color-scheme:dark){:root{--bg:#10161d;--fg:#e8eef4;--mut:#9aabba;--bd:#2a3744;--acc:#6ea1ff;--warn:#3a2e0d;--warnfg:#ffd77a}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}main{max-width:640px;margin:0 auto;padding:24px 16px}
.banner{background:var(--warn);color:var(--warnfg);padding:12px 16px;border-radius:8px;margin-bottom:20px}ul{list-style:none;padding:0;display:grid;gap:10px}
.btn{display:flex;flex-direction:column;padding:12px 16px;border:1px solid var(--bd);border-radius:8px;text-decoration:none;color:inherit}.btn span{color:var(--mut);font-size:14px}.btn.on{border-color:var(--acc)}
.btn:hover{border-color:var(--acc)}small{color:var(--mut)}</style></head><body><main>
<div class="banner"><b>DEMO ONLY</b> — өгөгдөл санах ойд (дахин асаахад арилна), нэвтрэлт хуурамч, OTP код үргэлж <b>${DEMO_OTP}</b>.</div>
<h1>Мерчант POS — demo</h1><p>Дүр сонгоход хөтөч <code>${COOKIE}</code> cookie авч, вэб апп руу шилжинэ (${esc(WEB_URL)}).</p>
<ul>${buttons}</ul><p><small>Сонгосон дүр: ${esc(current ?? 'байхгүй')} · <a href="/demo/logout">гарах</a></small></p></main></body></html>`;
}

async function main(): Promise<void> {
  const app = await NestFactory.create(DemoAppModule, { logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api');
  app.enableCors({ origin: corsOrigins(WEB_URL), credentials: true }); // вэб + loopback ихэр (localhost ↔ 127.0.0.1)

  const seeded = await seedDemo({
    merchants: app.get(MerchantService), plans: app.get(PlanService), leases: app.get(LeaseService), dashboard: app.get(DashboardService),
  }, clock);
  const personas = buildPersonas(seeded.fixtures.merchantA.id, seeded.fixtures.storeA1.id, seeded.fixtures.storeA2.id);
  const byKey = new Map(personas.map((p) => [p.key as string, p]));

  const server = app.getHttpAdapter().getInstance() as ExpressLike;

  // Бодит gateway-тэй ижил URL: `/api/origination/<зам>` → origination `/api/<зам>` (вэб-ийн merchant-api үүнийг дууддаг; Module 0 proxy-ийн pathRewrite).
  server.use((req, _res, next) => {
    if (req.url) req.url = req.url.replace(/^\/api\/origination(?=\/|\?|$)/, '/api');
    next();
  });

  // gateway-ийн дүр: cookie → GATEWAY_HEADERS. Клиентийн ирүүлсэн gateway толгойг ХЭЗЭЭ Ч, ЯМАР Ч замд устгана — Express route том жижиг үсэг үл ялгадаг
  // (`/API/...`) тул замаар нь шүүхгүй (spoofing-гүй).
  server.use((req, _res, next) => {
    applyDemoIdentity(req, byKey.get(parseCookies(req.headers.cookie)[COOKIE] ?? '')?.headers);
    next();
  });

  const html = (res: Res, status: number, body: string) => {
    res.statusCode = status;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(body);
  };
  const redirect = (res: Res, to: string, cookie?: string) => {
    res.statusCode = 302;
    if (cookie) res.setHeader('set-cookie', cookie);
    res.setHeader('location', to);
    res.end();
  };
  server.get('/demo', (req, res) => html(res, 200, demoPage(personas, parseCookies(req.headers.cookie)[COOKIE])));
  server.get('/demo/logout', (_req, res) => redirect(res, '/demo', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`));
  server.get('/demo/login/:persona', (req, res) => {
    const key = decodeURIComponent((req.url ?? '').split('?')[0].split('/').pop() ?? '');
    const persona = byKey.get(key); // зөвхөн белый жагсаалтын түлхүүр; хэрэглэгчийн утга cookie/redirect-д орохгүй
    if (!persona) return html(res, 404, '<!doctype html><meta charset="utf-8"><p>Unknown persona. <a href="/demo">Back</a></p>');
    redirect(res, persona.landing, `${COOKIE}=${persona.key}; Path=/; HttpOnly; SameSite=Lax`);
  });

  await app.listen(PORT, HOST);

  // Cookie хост-д холбогддог: /demo-г нээх хост нь вэб-ийн API суурьтай (NEXT_PUBLIC_GATEWAY_URL, анхдагч http://localhost:4000/api) ЯГ ТААРАХ ёстой.
  const apiOrigin = `http://${displayHost(HOST, WEB_URL)}:${PORT}`;
  const line = '='.repeat(72);
  console.log([
    line,
    ' DEMO ONLY — Merchant POS',
    ` * өгөгдөл санах ойд (дахин асаахад арилна), mock интеграци, OTP код тогтмол ${DEMO_OTP}`,
    ` * ${seeded.leases} лизинг (14 хоног): ${Object.entries(seeded.byStatus).map(([k, v]) => `${k}=${v}`).join(' ')}`,
    ` * persona сонгох : ${apiOrigin}/demo`,
    ` * API            : ${apiOrigin}/api  (health: /api/health)`,
    ` * вэб апп        : ${WEB_URL} (CORS + cookie зөвшөөрсөн; вэб-ийн NEXT_PUBLIC_GATEWAY_URL = ${apiOrigin}/api байх ёстой)`,
    line,
  ].join('\n'));

  const stop = () => { void app.close().finally(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err: unknown) => {
  console.error('merchant-demo failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
