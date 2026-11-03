#!/usr/bin/env node
// LOS Radix — локал суулгалт / ажиллуулалтын туслах. Зөвхөн Node-ын суурь сан ашиглана (Windows · macOS · Linux).
// Дэлгэрэнгүй гарын авлага: docs/LOCAL-SETUP.md
//
//   node scripts/local-setup.mjs            = setup: шалгалт → .env → Docker (Postgres, Redis) → суулгалт → migrate → seed
//   node scripts/local-setup.mjs start      бүх сервис + вэб (pnpm dev); Docker-ийн дэд бүтцийг шаардлагатай бол асаана
//   node scripts/local-setup.mjs demo       мерчант POS демо (Docker, DB хэрэггүй): demo сервер :4000 + вэб :3000
//   node scripts/local-setup.mjs check      асаалттай сервис бүрийн health + нэвтрэлтийн шалгалт
//   node scripts/local-setup.mjs test       автомат тестүүд (`los_test` DB-г өөрөө үүсгэнэ; тестийн хугацаанд `.env`-г түр хажуулдаг — CI-д `.env` байдаггүй)
//   node scripts/local-setup.mjs stop       Docker контейнерүүдийг зогсооно (өгөгдөл хэвээр)
//   node scripts/local-setup.mjs reset      Docker контейнер + өгөгдлийг УСТГАНА (--yes байхгүй бол асууна)
//
// Тугнууд: --skip-infra (Docker ашиглахгүй; DATABASE_URL, REDIS_URL-д өөрийн Postgres/Redis ажиллаж байх ёстой), --no-demo-data (setup: жишээ хүсэлт нэмэхгүй), --yes
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const command = args.find((a) => !a.startsWith('--')) ?? 'setup';
const SKIP_INFRA = flags.has('--skip-infra');

const SERVICES = [
  ['gateway', 4000], ['origination', 4001], ['kyc', 4002], ['scoring', 4003],
  ['valuation', 4004], ['dms', 4005], ['dwh-sync', 4006], ['portal-bff', 4007],
];
const WEB_PORT = 3000;
// minio нь Docker Hub-аас устсан тул локал горимд ашиглахгүй (docs/LOCAL-SETUP.md §9). host/inner = docker-compose.yml-ийн `ports: ["host:inner"]`
const INFRA = [
  { name: 'postgres', host: 5432, inner: 5432, program: 'PostgreSQL', winService: 'postgresql-x64-…' },
  { name: 'dwh', host: 5433, inner: 5432, program: 'PostgreSQL', winService: 'postgresql-x64-…' },
  { name: 'redis', host: 6379, inner: 6379, program: 'Redis', winService: 'Redis' },
];
const INFRA_SERVICES = INFRA.map((i) => i.name);
const LIBS_BUILT_MARKER = resolve(ROOT, 'packages/database/dist/index.js');
const ENV_PATH = resolve(ROOT, '.env');
const ENV_STASH = resolve(ROOT, 'node_modules/.env.stashed-for-tests'); // node_modules git-д ордоггүй
/** `test` командыг хүчээр таславал `.env` хажууд үлдэж болно — дараагийн ажиллуулалт бүр буцаана. */
function restoreStashedEnv() {
  if (existsSync(ENV_STASH) && !existsSync(ENV_PATH)) renameSync(ENV_STASH, ENV_PATH);
}
restoreStashedEnv();
const childEnv = { ...process.env, TURBO_TELEMETRY_DISABLED: '1', NEXT_TELEMETRY_DISABLED: '1' };

// ── туслахууд ──────────────────────────────────────────────────────────────
const say = (m = '') => console.log(m);
const head = (m) => console.log(`\n\x1b[1m▶ ${m}\x1b[0m`);
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
function fail(msg, hint) {
  console.error(`\n\x1b[31m✗ ${msg}\x1b[0m`);
  if (hint) console.error(hint);
  process.exit(1);
}
// Windows-д `pnpm` нь pnpm.cmd тул shell хэрэгтэй; `docker` бодит .exe — shell-гүй байвал зайтай аргууд (SQL гэх мэт) хуваагдахгүй
const needsShell = (cmd) => IS_WIN && cmd === 'pnpm';
/** Командыг терминалд шууд хэвлэж ажиллуулна. */
function run(cmd, cmdArgs, extra = {}) {
  say(`  $ ${[cmd, ...cmdArgs].join(' ')}`);
  return spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: needsShell(cmd), env: childEnv, ...extra }).status ?? 1;
}
function capture(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', shell: needsShell(cmd), env: childEnv });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function portBusy(port) {
  return new Promise((done) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); done(true); });
    s.once('error', () => done(false));
    s.setTimeout(1000, () => { s.destroy(); done(false); });
  });
}
async function waitFor(label, probe, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (probe()) return ok(`${label} бэлэн`);
    await sleep(2000);
  }
  fail(`${label} ${timeoutMs / 1000}с дотор бэлэн болсонгүй`, '  Лог харах: docker compose logs ' + label.toLowerCase());
}
function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (IS_WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGINT');
}

// ── шалгалтууд ──────────────────────────────────────────────────────────────
function checkTools({ needDocker }) {
  head('Хэрэгслүүдийг шалгаж байна');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) fail(`Node ${process.versions.node} хэтэрхий хуучин (22 буюу түүнээс дээш хэрэгтэй)`, '  Суулгах: https://nodejs.org (LTS) эсвэл `nvm install 22`');
  ok(`Node ${process.versions.node}`);

  const pnpm = capture('pnpm', ['--version']);
  if (pnpm.status !== 0) fail('pnpm олдсонгүй', '  Суулгах: `corepack enable && corepack prepare pnpm@9.12.0 --activate` (эсвэл `npm i -g pnpm@9`)');
  if (Number(pnpm.out.split('.')[0]) < 9) fail(`pnpm ${pnpm.out} хуучин (9+ хэрэгтэй)`, '  `corepack prepare pnpm@9.12.0 --activate`');
  ok(`pnpm ${pnpm.out}`);

  if (needDocker) {
    const d = capture('docker', ['info', '--format', '{{.ServerVersion}}']);
    if (d.status !== 0) {
      fail('Docker ажиллахгүй байна (Docker Desktop-ийг нээж, "Engine running" болтол хүлээнэ үү)',
        '  Docker суулгах боломжгүй бол: `node scripts/local-setup.mjs demo` (мерчант демо — Docker хэрэггүй), эсвэл өөрийн Postgres/Redis-тэй `--skip-infra`.');
    }
    if (capture('docker', ['compose', 'version']).status !== 0) fail('`docker compose` (v2) олдсонгүй — Docker Desktop-ийг шинэчилнэ үү');
    ok(`Docker ${d.out}`);
  }
}

/** `.env`-г `.env.example`-ээс үүсгэнэ (байвал дарахгүй) + локал ажиллагааг эвддэг мэдэгдэж буй 2 зүйлийг засна. */
function ensureEnv() {
  head('.env файлыг бэлдэж байна');
  const envPath = resolve(ROOT, '.env');
  const examplePath = resolve(ROOT, '.env.example');
  let created = false;
  if (!existsSync(envPath)) {
    if (!existsSync(examplePath)) fail('.env.example олдсонгүй — репогийн root-оос ажиллуулж байна уу?');
    copyFileSync(examplePath, envPath);
    created = true;
    ok('.env үүсгэлээ (.env.example-ээс, DEMO утгатай)');
  } else {
    ok('.env байна — хэвээр үлдээлээ');
  }
  let s = readFileSync(envPath, 'utf8');
  const before = s;
  // origination: ERP_* хоосон (`ERP_API_URL=`) байвал URL/secret-ийн шалгалтад унаж эхлэхгүй → mock горимд тайлбар болгоно
  s = s.replace(/^(ERP_API_URL|ERP_WEBHOOK_SECRET|ERP_API_TOKEN)=[ \t]*(\r?)$/gm, '# $1=$2');
  if (s !== before) warn('ERP_API_URL / ERP_WEBHOOK_SECRET / ERP_API_TOKEN хоосон мөрийг тайлбар болголоо (хоосон бол origination эхэлдэггүй)');
  // dms: docker-compose-ийн `minio/minio` image Docker Hub-аас устсан → файлыг санах ойд хадгална (зөвхөн шинэ .env-д)
  if (created && /^STORAGE_DRIVER=minio\s*$/m.test(s)) {
    s = s.replace(/^STORAGE_DRIVER=minio(\r?)$/m, 'STORAGE_DRIVER=memory$1');
    warn('STORAGE_DRIVER=memory болголоо: dms-ийн файлууд санах ойд хадгалагдана, dms дахин асахад арилна (docs/LOCAL-SETUP.md §9)');
  }
  if (s !== before) writeFileSync(envPath, s);
}

function envValue(name, fallback) {
  if (process.env[name]) return process.env[name]; // орчинд тавигдсан утга `.env`-ээс давуу (loadEnvFile-тэй адил)
  try {
    const m = readFileSync(resolve(ROOT, '.env'), 'utf8').match(new RegExp(`^${name}=(.*?)\\r?$`, 'm'));
    return m && m[1] ? m[1] : fallback;
  } catch { return fallback; }
}

/** gateway-ийн `iam.user` хүснэгтийн хэрэглэгчийн тоо: -1 = хүснэгт алга (migration хийгдээгүй), null = Docker-оор шалгах боломжгүй. */
function countSeedUsers() {
  if (SKIP_INFRA) return null;
  let user = 'los', db = 'los';
  try { const u = new URL(envValue('DATABASE_URL', 'postgresql://los:los@localhost:5432/los')); user = decodeURIComponent(u.username) || user; db = u.pathname.slice(1) || db; } catch { /* анхдагч */ }
  const r = capture('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', user, '-d', db, '-tAc', 'select count(*) from iam."user"']);
  if (r.status === 0 && /^\d+$/.test(r.out)) return Number(r.out);
  if (/does not exist/.test(r.out)) return -1;
  return null;
}
/** Seed үнэхээр ажилласан эсэхийг баталгаажуулж, үр дүнг хэвлэнэ. `true` = 5 хэрэглэгч бэлэн. */
function reportSeed() {
  const n = countSeedUsers();
  if (n === null) { warn('Seed хэрэглэгчийн тоог Docker-оор шалгаж чадсангүй (Docker/`--skip-infra`)'); return null; }
  if (n === -1) { console.log('  \x1b[31m✗\x1b[0m `iam.user` хүснэгт алга — migration хийгдээгүй (энэ үед вэб «Нэвтэрч чадсангүй. Дахин оролдоно уу.» гэж харуулна)'); return false; }
  if (n === 0) { console.log('  \x1b[31m✗\x1b[0m `iam.user` хоосон — seed хийгдээгүй (энэ үед вэб «Нэвтрэх нэр эсвэл нууц үг буруу» гэж харуулна)'); return false; }
  ok(`Seed хэрэглэгч: ${n} (admin, approver, manager, officer.a, officer.b)`);
  return true;
}

/** Манай compose-ийн контейнер одоо АСААЛТТАЙ эсэх (`ps --status`-аас үл хамаарна — хуучин compose дээр ч ажиллана). */
function ownRunning(name) {
  const r = capture('docker', ['compose', 'ps', '-q', name]);
  if (r.status !== 0) return false;
  return r.out.split(/\s+/).filter((id) => /^[0-9a-f]{12,64}$/.test(id))
    .some((id) => capture('docker', ['inspect', '-f', '{{.State.Running}}', id]).out === 'true');
}
/** Контейнерийн `inner` порт хост дээр аль портоор нээгдсэн бэ (`docker compose port`). Нээгдээгүй бол хоосон жагсаалт. */
function publishedHostPorts(name, inner) {
  const r = capture('docker', ['compose', 'port', name, String(inner)]);
  if (r.status !== 0) return [];
  return [...r.out.matchAll(/:(\d+)\s*$/gm)].map((m) => Number(m[1])).filter((n) => n > 0); // нээгдээгүй үед `:0` гэж хэвлэдэг хувилбар бий
}
/** Хост порт дээр (манай биш) Docker контейнер нээсэн бол нэрсийг нь буцаана. */
function dockerPublishers(port) {
  const r = capture('docker', ['ps', '--filter', `publish=${port}`, '--format', '{{.Names}}']);
  return r.status === 0 ? r.out.split(/\s+/).filter(Boolean) : [];
}
/** Хост дээрх өөрийн PostgreSQL/Redis-ийг зогсоох заавар. */
function stopHostServiceHint(i) {
  return IS_WIN
    ? `  1) Win+R → services.msc → «${i.winService}» (${i.program}) үйлчилгээг олж баруун товч → Stop (байнга бол Properties → Startup type: Manual)\n` +
      '     эсвэл Administrator PowerShell: `Get-Service *' + i.program.toLowerCase() + '*` → `Stop-Service <нэр>`'
    : `  1) Хост дээрх ${i.program}-ийг зогсоо: \`brew services stop ${i.program === 'Redis' ? 'redis' : 'postgresql'}\` эсвэл \`sudo systemctl stop ${i.program === 'Redis' ? 'redis-server' : 'postgresql'}\``;
}
/** Манай контейнер асаалттай ч порт нь гадагш нээгдээгүй бол зогсоно: ингэвэл migration танай өөрийн PostgreSQL руу холбогдож `P1000` өгнө. */
function verifyPublished(i) {
  const ports = publishedHostPorts(i.name, i.inner);
  if (ports.includes(i.host)) return;
  const now = ports.length ? `одоогийн порт: ${ports.join(', ')}` : `\`docker compose ps\` дээр «${i.inner}/tcp» гэж л харагдана`;
  fail(`${i.name} контейнер асаалттай боловч :${i.host} порт гадагш нээгдээгүй байна (${now})`,
    `  Шалтгаан: ихэвчлэн хост дээрх өөрийн ${i.program} :${i.host}-ыг эзэлсэн тул Docker порт нээж чадаагүй. Үүнийг засахгүй бол migration манай контейнер биш,\n` +
    `  таны ӨӨРИЙН ${i.program} руу холбогдож \`P1000: Authentication failed\` алдаа өгнө.\n` +
    `  Засах:\n${stopHostServiceHint(i)}\n  2) docker compose down\n  3) node scripts/local-setup.mjs`);
}

async function infraUp() {
  if (SKIP_INFRA) { warn('--skip-infra: Docker алгасав. DATABASE_URL болон REDIS_URL-д ажиллаж буй Postgres/Redis хэрэгтэй'); return; }
  head('Docker: Postgres, DWH, Redis асааж байна');
  const missing = [];
  for (const i of INFRA) {
    if (ownRunning(i.name)) continue; // манай контейнер аль хэдийн асаалттай → порт нь "эзлэгдсэн" нь хэвийн
    missing.push(i);
    if (await portBusy(i.host)) {
      const others = dockerPublishers(i.host);
      if (others.length) {
        fail(`:${i.host} портыг өөр Docker контейнер эзэлж байна: ${others.join(', ')} (${i.name} эхэлж чадахгүй)`,
          `  Түүнийг зогсоо: docker stop ${others[0]}   (хэрэв энэ өмнөх LOS-ийн контейнер бол: docker compose down)\n  Дараа нь: node scripts/local-setup.mjs`);
      }
      fail(`:${i.host} порт өөр програмд эзлэгдсэн байна (${i.name} эхэлж чадахгүй)`,
        `  Ихэвчлэн өөрийн суулгасан ${i.program} байдаг.\n  Засах:\n${stopHostServiceHint(i)}\n  2) node scripts/local-setup.mjs   (эсвэл Docker-гүй: --skip-infra)`);
    }
  }
  if (missing.length) {
    if (run('docker', ['compose', 'up', '-d', ...INFRA_SERVICES]) !== 0) fail('docker compose up амжилтгүй');
  } else {
    ok('Манай Docker-ийн дэд бүтэц (postgres, dwh, redis) аль хэдийн ажиллаж байна');
  }
  INFRA.forEach(verifyPublished); // "Started" гэсэн ч порт нь нээгдээгүй байж болно
  ok(INFRA.map((i) => `${i.name} :${i.host}`).join(' · ') + ' — портууд хост дээр нээлттэй');
  const px = (svc, ...cmd) => () => capture('docker', ['compose', 'exec', '-T', svc, ...cmd]).status === 0;
  await waitFor('Postgres', px('postgres', 'pg_isready', '-U', 'los', '-d', 'los'));
  await waitFor('DWH', px('dwh', 'pg_isready', '-U', 'dwh', '-d', 'dwh'));
  await waitFor('Redis', () => /PONG/.test(capture('docker', ['compose', 'exec', '-T', 'redis', 'redis-cli', 'ping']).out));
}

/** Prisma client-үүдийг ДАРААЛУУЛЖ үүсгэнэ: зэрэг (turbo-ийн анхдагч) ажиллахад Windows дээр query engine файлд `EPERM: operation not permitted, rename …` гардаг. */
function generateClients() {
  if (run('pnpm', ['turbo', 'run', 'db:generate', '--concurrency=1']) !== 0) {
    fail('Prisma client үүсгэж чадсангүй (db:generate)', '  Windows-д EPERM гарвал: антивирус/өөр терминалыг хааж, `pnpm turbo run db:generate --concurrency=1`-ийг дахин ажиллуул.');
  }
}

function buildLibs() {
  if (run('pnpm', ['turbo', 'run', 'build', '--filter=./packages/*']) !== 0) fail('packages/* build амжилтгүй');
}

function printLogins() {
  const pw = envValue('SEED_PASSWORD', 'Los@2026!dev');
  say(`
  Нэвтрэх: http://localhost:${WEB_PORT}/login      нууц үг (бүгдэд): ${pw}
    admin        ADMIN             — бүх цэс + Тохиргоо
    approver     APPROVER          — бүгдийг харна
    manager      BRANCH_MANAGER    — Төв салбар
    officer.a    OFFICER           — Төв (100)
    officer.b    OFFICER           — Баянзүрх (200)`);
}

// ── командууд ──────────────────────────────────────────────────────────────
async function setup() {
  checkTools({ needDocker: !SKIP_INFRA });
  ensureEnv();
  await infraUp();
  head('1/4 Хамаарлуудыг суулгаж байна (pnpm install)');
  if (run('pnpm', ['install', '--frozen-lockfile']) !== 0) fail('pnpm install амжилтгүй');
  head('2/4 Prisma client үүсгэж, нийтлэг сангуудыг build хийж байна');
  generateClients();
  buildLibs(); // seed нь @los/database-ийн dist-ийг ашигладаг тул ЗААВАЛ seed-ээс өмнө
  head('3/4 Өгөгдлийн сангийн migration (6 сервис)');
  if (run('pnpm', ['db:migrate']) !== 0) {
    fail('pnpm db:migrate амжилтгүй',
      '  Postgres ажиллаж байгаа эсэх, DATABASE_URL-ийг шалга: docker compose ps\n' +
      '  `P1000: Authentication failed` гарсан бол :5432 дээр манай биш, таны ӨӨРИЙН PostgreSQL хариулж байна: түүнийг зогсоо (Windows: services.msc → postgresql → Stop),\n' +
      '  дараа нь `docker compose down` → `node scripts/local-setup.mjs` (docs/LOCAL-SETUP.md §8).');
  }
  head('4/4 Анхны өгөгдөл (seed): хэрэглэгч, тохиргоо, бүтээгдэхүүн, үнийн суурь');
  if (run('pnpm', ['db:seed']) !== 0) fail('pnpm db:seed амжилтгүй');
  // Туршилтын 1 ноорог хүсэлт (DEMO-COL-0001; барьцааны алхмуудыг гараар туршихад). turbo `SEED_DEMO`-г дамжуулдаггүй тул origination-ийг шууд дуудна; давтаж болно
  if (!flags.has('--no-demo-data')) {
    say('  + туршилтын жишээ хүсэлт (SEED_DEMO=1)');
    if (run('pnpm', ['--filter', '@los/origination', 'db:seed'], { env: { ...childEnv, SEED_DEMO: '1' } }) !== 0) fail('SEED_DEMO seed амжилтгүй');
  }
  head('Seed-ийг баталгаажуулж байна');
  if (reportSeed() === false) fail('Seed/migration дутуу байна', '  Дахин: node scripts/local-setup.mjs (давтаж болно). Алдааны мөрүүдийг дээрээс хар.');
  head('Бэлэн боллоо ✔');
  say('  Асаах:        node scripts/local-setup.mjs start');
  say('  Шалгах:       node scripts/local-setup.mjs check   (өөр терминалд)');
  say('  Мерчант демо: node scripts/local-setup.mjs demo    (Docker хэрэггүй)');
  printLogins();
}

async function ensurePortsFree(ports) {
  const busy = [];
  for (const p of ports) if (await portBusy(p)) busy.push(p);
  if (busy.length) {
    fail(`Дараах портууд аль хэдийн ашиглагдаж байна: ${busy.join(', ')}`,
      '  Өмнөх `pnpm dev` / demo дуусаагүй байж болно. Ажиллаж буй терминалд Ctrl+C дарж зогсоо, эсвэл тэр процессийг устга.');
  }
}

/** Хэд хэдэн урт процессийг зэрэг ажиллуулж, Ctrl+C дээр бүгдийг нь зогсооно. */
function runForeground(jobs) {
  return new Promise((done) => {
    const kids = jobs.map((j) => spawn(j.cmd, j.args, { cwd: ROOT, stdio: 'inherit', shell: needsShell(j.cmd), env: childEnv }));
    let stopping = false;
    const stopAll = () => { stopping = true; kids.forEach(killTree); };
    // Терминалын Ctrl+C нь хүүхдүүдэд өөрөө хүрдэг (давхар SIGINT turbo-г хүчээр зогсооно) → энд зөвхөн хүлээнэ, гацвал 15с-ийн дараа зогсооно
    process.on('SIGINT', () => { stopping = true; setTimeout(() => kids.forEach(killTree), 15_000).unref(); });
    process.on('SIGTERM', stopAll);
    let exited = 0;
    kids.forEach((k, i) => k.on('exit', (code) => {
      exited += 1;
      if (!stopping) { warn(`${jobs[i].name} зогслоо (код ${code}) — бусдыг зогсоож байна`); stopAll(); }
      if (exited === kids.length) done(code ?? 0);
    }));
  });
}

async function start() {
  checkTools({ needDocker: !SKIP_INFRA });
  if (!existsSync(resolve(ROOT, '.env')) || !existsSync(resolve(ROOT, 'node_modules')) || !existsSync(LIBS_BUILT_MARKER)) {
    fail('Суулгалт хийгдээгүй байна', '  Эхлээд: node scripts/local-setup.mjs');
  }
  ensureEnv();
  await infraUp();
  await ensurePortsFree([WEB_PORT, ...SERVICES.map(([, p]) => p)]);
  head('Бүх сервис + вэб асааж байна (анхны ачаалал ~1 минут; зогсоох: Ctrl+C)');
  say(`  Вэб: http://localhost:${WEB_PORT}   ·   Gateway: http://localhost:4000/api/health`);
  printLogins();
  say('');
  process.exit(await runForeground([{ name: 'pnpm dev', cmd: 'pnpm', args: ['dev'] }]));
}

async function demo() {
  checkTools({ needDocker: false });
  if (!existsSync(resolve(ROOT, 'node_modules'))) {
    head('Хамаарлуудыг суулгаж байна');
    if (run('pnpm', ['install', '--frozen-lockfile']) !== 0) fail('pnpm install амжилтгүй');
  }
  if (!existsSync(LIBS_BUILT_MARKER)) {
    head('Prisma client + нийтлэг сангуудыг бэлдэж байна');
    generateClients();
    buildLibs();
  }
  await ensurePortsFree([WEB_PORT, 4000]);
  head('Мерчант POS демо (DEMO ONLY: өгөгдөл санах ойд, OTP код 123456; зогсоох: Ctrl+C)');
  say('  1) Вэб бэлэн болмогц нээ:   http://localhost:4000/demo   ← дүр сонгоно (кассир, мерчантын админ, шинжээч, админ)');
  say('  2) Нэвтрэх нууц үг шаардахгүй — /demo хуудаснаас дүр сонгоно.\n');
  process.exit(await runForeground([
    { name: 'demo сервер', cmd: 'pnpm', args: ['--filter', '@los/origination', 'demo:merchant'] },
    { name: 'вэб', cmd: 'pnpm', args: ['--filter', '@los/web', 'dev'] },
  ]));
}

async function check() {
  head('Сервисүүдийн health');
  let bad = 0;
  const get = async (url, init, timeoutMs = 8000) => {
    try { return await fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...init }); } catch { return null; }
  };
  for (const [name, port] of SERVICES) {
    const r = await get(`http://localhost:${port}/api/health`);
    if (r?.ok) ok(`${name.padEnd(12)} :${port}`); else { bad += 1; console.log(`  \x1b[31m✗\x1b[0m ${name.padEnd(12)} :${port}  (асаагүй эсвэл алдаатай)`); }
  }
  say('  (вэб анхны удаа хуудсаа compile хийдэг тул 1 минут хүртэл хүлээж магадгүй)');
  const web = await get(`http://localhost:${WEB_PORT}/login`, undefined, 90_000);
  if (web?.ok) ok(`web          :${WEB_PORT}`); else { bad += 1; console.log(`  \x1b[31m✗\x1b[0m web          :${WEB_PORT}`); }

  head('Нэвтрэлт (admin)');
  const pw = envValue('SEED_PASSWORD', 'Los@2026!dev');
  const seeded = reportSeed();
  if (seeded === false) bad += 1;
  const login = await get('http://localhost:4000/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: pw }),
  });
  if (login?.ok) {
    const j = await login.json();
    ok(`admin нэвтэрлээ · дүр: ${j.user.roles.join(', ')} · цэс: ${j.menu.map((m) => m.id).join(', ')}`);
  } else {
    bad += 1;
    const body = login ? await login.json().catch(() => ({})) : {};
    const problem = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
    if (!login) problem('gateway (:4000) хариу өгсөнгүй — асаагүй эсвэл өөр програм эзэлсэн');
    else if (login.status === 401) problem(`HTTP 401 ${body.code ?? ''}: gateway ажиллаж байна, гэхдээ \`admin\` / \`${pw}\` таарсангүй. Seed хийгдээгүй, эсвэл seed өөр SEED_PASSWORD-оор хийгдсэн (seed нууц үгийг дахин тохируулдаггүй)`);
    else if (login.status === 429) problem('HTTP 429: нэвтрэлт минутад 10-аар хязгаарлагдсан — 1 минут хүлээнэ үү');
    else if (login.status >= 500) problem(`HTTP ${login.status} ${body.code ?? ''}: gateway-ийн дотоод алдаа — ихэвчлэн \`iam\` хүснэгт үүсээгүй (migration) эсвэл Prisma client буруу. Зас: node scripts/local-setup.mjs (давтаж болно); gateway-ийн лог: \`@los/gateway:dev\` мөрүүд`);
    else problem(`HTTP ${login.status} ${body.code ?? ''}: :4000 дээр gateway биш өөр програм хариулж байж магадгүй`);
  }
  say(bad ? `\n\x1b[31m${bad} алдаа.\x1b[0m docs/LOCAL-SETUP.md §8 (асуудал шийдэх)-ийг үз.` : '\n\x1b[32mБүгд хэвийн ✔\x1b[0m');
  process.exit(bad ? 1 : 0);
}

async function test() {
  checkTools({ needDocker: !SKIP_INFRA });
  await infraUp();
  if (!SKIP_INFRA) {
    // `createdb` нь аль хэдийн байвал алдаа буцаана — зүгээр (шинэчлэх нь тестийн global-setup-ийн ажил)
    capture('docker', ['compose', 'exec', '-T', 'postgres', 'createdb', '-U', 'los', 'los_test']);
    ok('los_test DB бэлэн (тест зөвхөн энэ DB-г цэвэрлэнэ; `los` DB-д хүрэхгүй)');
  }
  head('pnpm test (бүх багц)');
  // Root `.env` (INTERNAL_AUTH_SECRET гэх мэт) нь сервисүүдийн тестэд 401 INVALID_INTERNAL_TOKEN үүсгэдэг → тест дууртал түр хажуулна (CI-д .env байдаггүй)
  const stashed = existsSync(ENV_PATH) && !existsSync(ENV_STASH);
  if (stashed) { renameSync(ENV_PATH, ENV_STASH); warn('.env-г түр node_modules/.env.stashed-for-tests болгов (тест дуусмагц буцаана)'); }
  process.on('exit', restoreStashedEnv);
  process.on('SIGINT', () => {}); // Ctrl+C хүүхэд процессод хүрнэ; энд зөвхөн .env-г буцаах хүртэл амьд байлгана
  const env = {
    ...childEnv, NODE_ENV: 'test',
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://los:los@localhost:5432/los_test',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379/2',
  };
  const code = run('pnpm', ['test'], { env });
  restoreStashedEnv();
  process.exit(code);
}

async function stop() {
  head('Docker контейнерүүдийг зогсоож байна (өгөгдөл хэвээр)');
  process.exit(run('docker', ['compose', 'stop']));
}

async function reset() {
  say('\x1b[31mАНХААР:\x1b[0m энэ нь Docker дахь Postgres/DWH/Redis-ийн БҮХ локал өгөгдлийг устгана (хэрэглэгч, seed, таны оруулсан бүх зүйл).');
  if (!flags.has('--yes')) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Үргэлжлүүлэх бол "yes" гэж бичнэ үү: ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'yes') { say('Цуцаллаа.'); return; }
  }
  if (run('docker', ['compose', 'down', '-v']) !== 0) fail('docker compose down амжилтгүй');
  say('\nУстгалаа. Шинээр суулгах: node scripts/local-setup.mjs');
}

const COMMANDS = { setup, start, demo, check, test, stop, reset };
if (!COMMANDS[command]) {
  fail(`Үл мэдэгдэх команд: ${command}`, `  Боломжтой: ${Object.keys(COMMANDS).join(' | ')}  (дэлгэрэнгүй: файлын дээд тайлбар, docs/LOCAL-SETUP.md)`);
}
await COMMANDS[command]();
