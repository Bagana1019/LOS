import { z } from 'zod';
import { MockErpClient } from './mock.client';
import { RealErpClient } from './real.client';
import type { ErpGateway } from './erp.interface';

const Env = z.object({
  INTEGRATION_MODE: z.enum(['mock', 'real']).optional(),
  ERP_API_URL: z.string().url().optional(),
  ERP_API_TOKEN: z.string().min(1).optional(),
  ERP_WEBHOOK_SECRET: z.string().min(16).optional(),
  ERP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000), // CLAUDE.md §3.1: гадаад дуудлага 15с
  ERP_ALLOW_INSECURE: z.enum(['true', 'false']).default('false'),
  // true бол хүлээн авагч 2xx хариунд лавлах дугаар (reference/id…) заавал буцаах ёстой. Лавлах дугаар өгдөггүй системд л false болгоно.
  ERP_REQUIRE_ACK: z.enum(['true', 'false']).default('true'),
});
export type ErpEnv = Omit<z.infer<typeof Env>, 'INTEGRATION_MODE'> & { INTEGRATION_MODE: 'mock' | 'real' };

// Production-д INTEGRATION_MODE заавал тодорхой: орхигдуулсан бол чимээгүй mock болж үйл явдал огт илгээгдэхгүй байхаас сэргийлнэ
export function resolveIntegrationMode(env: Record<string, string | undefined>, errorPrefix = 'invalid ERP integration config'): 'mock' | 'real' {
  const m = env.INTEGRATION_MODE;
  if (m === undefined) {
    if (env.NODE_ENV === 'production') throw new Error('INTEGRATION_MODE must be set explicitly (mock | real) in production');
    return 'mock';
  }
  if (m !== 'mock' && m !== 'real') throw new Error(`${errorPrefix}: INTEGRATION_MODE`);
  return m;
}

export function parseErpEnv(env: Record<string, string | undefined>): ErpEnv {
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw new Error(`invalid ERP integration config: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  return { ...parsed.data, INTEGRATION_MODE: resolveIntegrationMode(env) };
}

export function createErpGateway(env: ErpEnv): ErpGateway {
  if (env.INTEGRATION_MODE === 'mock') return new MockErpClient();
  if (!env.ERP_API_URL || !env.ERP_WEBHOOK_SECRET) throw new Error('INTEGRATION_MODE=real requires ERP_API_URL and ERP_WEBHOOK_SECRET');
  return new RealErpClient({
    url: env.ERP_API_URL, webhookSecret: env.ERP_WEBHOOK_SECRET, token: env.ERP_API_TOKEN,
    timeoutMs: env.ERP_TIMEOUT_MS, allowInsecure: env.ERP_ALLOW_INSECURE === 'true', requireAck: env.ERP_REQUIRE_ACK === 'true',
  });
}
