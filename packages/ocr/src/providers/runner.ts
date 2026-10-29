// Дэд процесс ажиллуулагч (CommandRunner) — инжектлэх боломжтой тул tesseract provider-ийг fake runner-аар тестлэнэ.
// Үндсэн хэрэгжилт: node:child_process spawn, SHELL-ГҮЙ (args массив), timeout + kill, stdout хэмжээний хязгаар.
import { spawn } from 'node:child_process';

export interface RunOptions {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  /** Эхний maxStderrBytes л хадгална — зөвхөн оношилгоо; гадагш гаргахдаа scrub хийнэ */
  stderr: string;
  timedOut: boolean;
  /** stdout хязгаараас хэтэрсэн (процессыг зогсоосон) */
  stdoutTruncated: boolean;
}

/** ENOENT/EACCES зэрэг spawn алдааг (Error.code-той) reject хийнэ; бусад бүх үр дүнг resolve хийнэ. */
export type CommandRunner = (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

/** Дэд процесст өгөх env-ийн цагаан жагсаалт: нууц утга (DB, токен) tesseract руу дамжихгүй. */
export function buildChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allow = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TESSDATA_PREFIX'];
  const env: NodeJS.ProcessEnv = { OMP_THREAD_LIMIT: '1' }; // tesseract-ийн OpenMP давхар thread-ээс сэргийлнэ
  for (const key of allow) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

export const spawnRunner: CommandRunner = (command, args, options) =>
  new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: options.env ?? buildChildEnv(process.env), windowsHide: true });
    const out: Buffer[] = [];
    let outBytes = 0;
    let errText = '';
    let timedOut = false;
    let truncated = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      outBytes += chunk.length;
      if (outBytes > options.maxStdoutBytes) {
        truncated = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errText.length < options.maxStderrBytes) errText += chunk.toString('utf8').slice(0, options.maxStderrBytes - errText.length);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout: truncated ? '' : Buffer.concat(out).toString('utf8'), stderr: errText, timedOut, stdoutTruncated: truncated });
    });
  });
