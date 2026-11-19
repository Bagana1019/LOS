// ХУР (XYP) тохиргоо: env → config. Нууц (XYP_ACCESS_TOKEN, түлхүүрийн файл) код, лог, тестэд орохгүй; алдаа зөвхөн хувьсагчийн НЭРийг заана.
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { IntegrationNotConfiguredError } from '../errors';
import { assertRealIntegrationEnv, isProduction, requireEnv } from '../integration-env';
import { resolveIntegrationMode } from '../integration-mode';
import { loadXypPrivateKey } from './xyp-signer';

type Env = Record<string, string | undefined>;
export type ReadFile = (path: string) => Buffer;

/** Production + real үед БҮГД заавал. XYP_ACCESS_TOKEN, түлхүүр нь ҮДТ-ээс байгууллагад олгогддог. */
export const XYP_REQUIRED_ENV = ['XYP_ACCESS_TOKEN', 'XYP_PRIVATE_KEY_PATH'] as const;
/** gsb-ийн config.py-ийн анхдагч (нийтэд ил, нууц биш). Бодит endpoint/namespace нь WSDL-ээс ажиллах үед уншигдана. */
export const XYP_DEFAULT_CITIZEN_WSDL = 'https://xyp.gov.mn/citizen-1.5.0/ws?WSDL';
/** WS100008 (иргэний код илгээх) нь `meta` WSDL-д (vendor demo OTPApprove.py, gsb config.py-ийн анхдагч). Нийтэд ил, нууц биш. */
export const XYP_DEFAULT_META_WSDL = 'https://xyp.gov.mn/meta-1.5.0/ws?WSDL';
export const XYP_DEFAULT_TIMEOUT_MS = 15_000; // CLAUDE.md §3.1: гадаад дуудлага 15с

export interface XypConfig {
  accessToken: string;
  privateKey: KeyObject;
  citizenWsdlUrl: string;
  /** SOAP endpoint-ийн тодорхой override. Байхгүй бол WSDL-ийн зарласан endpoint (WSDL-ийн хостой ижил, production-д https байх шаардлагатай) ашиглана. */
  endpointOverride?: string;
  /** Иргэний код илгээх (WS100008) `meta` үйлчилгээ: citizen-ээс тусдаа WSDL, endpoint. */
  metaWsdlUrl: string;
  metaEndpointOverride?: string;
  timeoutMs: number;
}

/** Хоосон → undefined; http(s) URL биш бол "(invalid)". */
function readEndpointOverride(env: Env, name: 'XYP_CITIZEN_ENDPOINT_URL' | 'XYP_META_ENDPOINT_URL'): string | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') return raw;
  } catch {
    /* доорх алдаа */
  }
  throw new IntegrationNotConfiguredError('xyp', [`${name} (invalid)`]);
}

function readTimeoutMs(env: Env): number {
  const raw = env.XYP_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return XYP_DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new IntegrationNotConfiguredError('xyp', ['XYP_TIMEOUT_MS (invalid)']);
  return n;
}

export function loadXypConfig(env: Env = process.env, readFile: ReadFile = (path) => readFileSync(path)): XypConfig {
  const e = requireEnv('xyp', XYP_REQUIRED_ENV, env);
  let material: Buffer;
  try {
    material = readFile(e.XYP_PRIVATE_KEY_PATH!);
  } catch {
    throw new IntegrationNotConfiguredError('xyp', ['XYP_PRIVATE_KEY_PATH (unreadable)']);
  }
  let privateKey: KeyObject;
  try {
    privateKey = loadXypPrivateKey(material);
  } catch {
    throw new IntegrationNotConfiguredError('xyp', ['XYP_PRIVATE_KEY_PATH (invalid)']);
  }
  const wsdl = env.XYP_CITIZEN_WSDL_URL?.trim();
  const metaWsdl = env.XYP_META_WSDL_URL?.trim();
  return {
    accessToken: e.XYP_ACCESS_TOKEN!, privateKey, citizenWsdlUrl: wsdl ? wsdl : XYP_DEFAULT_CITIZEN_WSDL, endpointOverride: readEndpointOverride(env, 'XYP_CITIZEN_ENDPOINT_URL'),
    metaWsdlUrl: metaWsdl ? metaWsdl : XYP_DEFAULT_META_WSDL, metaEndpointOverride: readEndpointOverride(env, 'XYP_META_ENDPOINT_URL'), timeoutMs: readTimeoutMs(env),
  };
}

/** Регистр, гарын үсэг, иргэний код http-ээр явахгүй: production-д URL зөв, https байх ёстой. Алдаа зөвхөн хувьсагчийн нэрийг заана. */
function assertHttpsInProduction(value: string, name: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL. Refusing to start`);
  }
  if (url.protocol !== 'https:') throw new Error(`${name} must use https in production. Refusing to start`);
}

/**
 * Phase 5: production + real → env бүрэн, түлхүүр уншигдаж хүчинтэй, WSDL URL https (хүсэлтийн гарын үсэг, регистр http-ээр явахгүй).
 * Production биш / mock үед юу ч хийхгүй (түлхүүрийн файлыг ч уншихгүй).
 */
export function assertXypProductionConfig(env: Env = process.env, readFile?: ReadFile): void {
  assertRealIntegrationEnv('xyp', XYP_REQUIRED_ENV, env);
  if (!isProduction(env) || resolveIntegrationMode(env) !== 'real') return;
  const cfg = loadXypConfig(env, readFile);
  assertHttpsInProduction(cfg.citizenWsdlUrl, 'XYP_CITIZEN_WSDL_URL');
  assertHttpsInProduction(cfg.metaWsdlUrl, 'XYP_META_WSDL_URL');
  // Тодорхой endpoint өгсөн бол https (accessToken, гарын үсэг, регистр, иргэний код http-ээр явахгүй). Өгөөгүй бол WSDL-ийн зарласан endpoint-ийг ажиллах үед transport шалгана.
  if (cfg.endpointOverride) assertHttpsInProduction(cfg.endpointOverride, 'XYP_CITIZEN_ENDPOINT_URL');
  if (cfg.metaEndpointOverride) assertHttpsInProduction(cfg.metaEndpointOverride, 'XYP_META_ENDPOINT_URL');
}
