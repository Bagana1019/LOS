import { describe, expect, it } from 'vitest';
import { buildChildEnv, spawnRunner, type RunOptions } from './runner';

const NODE = process.execPath;
const opts = (over: Partial<RunOptions> = {}): RunOptions => ({ timeoutMs: 10_000, maxStdoutBytes: 1_000_000, maxStderrBytes: 1_000, ...over });

describe('spawnRunner (жинхэнэ дэд процесс, node-оор)', () => {
  it('stdout/stderr/exit code-ыг буцаана', async () => {
    const ok = await spawnRunner(NODE, ['-e', "process.stdout.write('сайн'); process.stderr.write('warn')"], opts());
    expect(ok).toMatchObject({ exitCode: 0, stdout: 'сайн', stderr: 'warn', timedOut: false, stdoutTruncated: false });
    const bad = await spawnRunner(NODE, ['-e', 'process.exit(3)'], opts());
    expect(bad.exitCode).toBe(3);
  });

  it('SHELL-ГҮЙ: метасимвол бүхий аргумент шууд утгаараа дамжина (инъекц байхгүй)', async () => {
    const payload = '; echo pwned $(id) `id` | cat > /dev/null &';
    const r = await spawnRunner(NODE, ['-e', 'process.stdout.write(process.argv[1])', payload], opts());
    expect(r.stdout).toBe(payload);
  });

  it('байхгүй команд → ENOENT кодтой reject', async () => {
    await expect(spawnRunner('/nonexistent/los-ocr-binary', [], opts())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('timeout: процессыг алж timedOut=true буцаана', async () => {
    const started = Date.now();
    const r = await spawnRunner(NODE, ['-e', 'setTimeout(() => {}, 30000)'], opts({ timeoutMs: 300 }));
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('stdout-ийн хэмжээ хязгаараас хэтэрвэл процессыг зогсоож stdoutTruncated=true, хэсэгчилсэн өгөгдөл буцаахгүй', async () => {
    const r = await spawnRunner(NODE, ['-e', "process.stdout.write('x'.repeat(200000)); setTimeout(() => {}, 30000)"], opts({ maxStdoutBytes: 1_000 }));
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stdout).toBe('');
  });

  it('stderr нь maxStderrBytes-ээр хязгаарлагдана', async () => {
    const r = await spawnRunner(NODE, ['-e', "process.stderr.write('e'.repeat(100000))"], opts({ maxStderrBytes: 50 }));
    expect(r.stderr.length).toBeLessThanOrEqual(50);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it('олон байт тэмдэгт chunk-ын захаар таслагдсан ч эвдрэхгүй (төгсгөлд нэг удаа decode)', async () => {
    const r = await spawnRunner(NODE, ['-e', "process.stdout.write('Монгол '.repeat(20000))"], opts());
    expect(r.stdout.startsWith('Монгол Монгол')).toBe(true);
    expect(r.stdout).not.toContain('�');
  });
});

describe('buildChildEnv', () => {
  it('зөвхөн цагаан жагсаалтын хувьсагч дамжина, OMP_THREAD_LIMIT=1 нэмнэ', () => {
    const env = buildChildEnv({ PATH: '/bin', HOME: '/h', TESSDATA_PREFIX: '/t', DATABASE_URL: 'x', REDIS_URL: 'y', ENCRYPTION_KEY: 'z' });
    expect(env).toEqual({ OMP_THREAD_LIMIT: '1', PATH: '/bin', HOME: '/h', TESSDATA_PREFIX: '/t' });
  });
});
