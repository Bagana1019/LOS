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
const INFRA_SERVICES = ['postgres', 'dwh', 'redis']; // minio нь Docker Hub-аас устсан тул локал горимд ашиглахгүй (docs/LOCAL-SETUP.md §9)
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
/** Командыг терминалд шууд хэвлэж ажиллуулна. Windows-д `pnpm`/`docker` нь .cmd тул shell хэрэгтэй. */
function run(cmd, cmdArgs, extra = {}) {
  say(`  $ ${[cmd, ...cmdArgs].join(' ')}`);
  return spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: IS_WIN, env: childEnv, ...extra }).status ?? 1;
}
function capture(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', shell: IS_WIN, env: childEnv });
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
  try {
    const m = readFileSync(resolve(ROOT, '.env'), 'utf8').match(new RegExp(`^${name}=(.*?)\\r?$`, 'm'));
    return m && m[1] ? m[1] : fallback;
  } catch { return fallback; }
}

async function infraUp() {
  if (SKIP_INFRA) { warn('--skip-infra: Docker алгасав. DATABASE_URL болон REDIS_URL-д ажиллаж буй Postgres/Redis хэрэгтэй'); return; }
  head('Docker: Postgres, DWH, Redis асааж байна');
  const ps = capture('docker', ['compose', 'ps', '--status', 'running', '--services']);
  const running = ps.status === 0 ? ps.out.split(/\s+/) : null; // хуучин compose `--status`-гүй бол null → доор `up -d` (давтаж болно)
  const missing = running ? INFRA_SERVICES.filter((s) => !running.includes(s)) : INFRA_SERVICES;
  if (missing.length) {
    for (const [name, port] of [['postgres', 5432], ['dwh', 5433], ['redis', 6379]]) {
      if (running && missing.includes(name) && (await portBusy(port))) {
        fail(`:${port} порт өөр програмд эзлэгдсэн байна (${name} эхэлж чадахгүй)`,
          '  Ихэвчлэн өөрийн суулгасан PostgreSQL / Redis байдаг. Түүнийг түр зогсоох эсвэл --skip-infra хэрэглэнэ.');
      }
    }
    if (run('docker', ['compose', 'up', '-d', ...INFRA_SERVICES]) !== 0) fail('docker compose up амжилтгүй');
  } else {
    ok('Docker-ийн дэд бүтэц аль хэдийн ажиллаж байна');
  }
  const px = (svc, ...cmd) => () => capture('docker', ['compose', 'exec', '-T', svc, ...cmd]).status === 0;
  await waitFor('Postgres', px('postgres', 'pg_isready', '-U', 'los', '-d', 'los'));
  await waitFor('DWH', px('dwh', 'pg_isready', '-U', 'dwh', '-d', 'dwh'));
  await waitFor('Redis', () => /PONG/.test(capture('docker', ['compose', 'exec', '-T', 'redis', 'redis-cli', 'ping']).out));
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
  if (run('pnpm', ['db:generate']) !== 0) fail('pnpm db:generate амжилтгүй');
  buildLibs(); // seed нь @los/database-ийн dist-ийг ашигладаг тул ЗААВАЛ seed-ээс өмнө
  head('3/4 Өгөгдлийн сангийн migration (6 сервис)');
  if (run('pnpm', ['db:migrate']) !== 0) fail('pnpm db:migrate амжилтгүй', '  Postgres ажиллаж байгаа эсэх, DATABASE_URL-ийг шалга: docker compose ps');
  head('4/4 Анхны өгөгдөл (seed): хэрэглэгч, тохиргоо, бүтээгдэхүүн, үнийн суурь');
  if (run('pnpm', ['db:seed']) !== 0) fail('pnpm db:seed амжилтгүй');
  // Туршилтын 1 ноорог хүсэлт (DEMO-COL-0001; барьцааны алхмуудыг гараар туршихад). turbo `SEED_DEMO`-г дамжуулдаггүй тул origination-ийг шууд дуудна; давтаж болно
  if (!flags.has('--no-demo-data')) {
    say('  + туршилтын жишээ хүсэлт (SEED_DEMO=1)');
    if (run('pnpm', ['--filter', '@los/origination', 'db:seed'], { env: { ...childEnv, SEED_DEMO: '1' } }) !== 0) fail('SEED_DEMO seed амжилтгүй');
  }
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
    const kids = jobs.map((j) => spawn(j.cmd, j.args, { cwd: ROOT, stdio: 'inherit', shell: IS_WIN, env: childEnv }));
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
    if (run('pnpm', ['db:generate']) !== 0) fail('pnpm db:generate амжилтгүй');
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
  const login = await get('http://localhost:4000/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: envValue('SEED_PASSWORD', 'Los@2026!dev') }),
  });
  if (login?.ok) {
    const j = await login.json();
    ok(`admin нэвтэрлээ · дүр: ${j.user.roles.join(', ')} · цэс: ${j.menu.map((m) => m.id).join(', ')}`);
  } else {
    bad += 1;
    console.log(`  \x1b[31m✗\x1b[0m нэвтрэлт амжилтгүй (${login ? `HTTP ${login.status}` : 'gateway хариу өгсөнгүй'}). Seed хийсэн үү? Нэвтрэлт минутад 10 удаагаар хязгаарлагдсан.`);
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
