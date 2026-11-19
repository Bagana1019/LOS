// M8 (real DB): Prisma survives a DB outage and recovers without a restart. The outage is simulated by an in-process TCP proxy between
// Prisma and this suite's own test database — no Docker container is touched.
import { createServer, connect, type Server, type Socket } from 'node:net';
import { connectWithRetry, isTransientDbError } from '@los/database';
import { PrismaClient } from '.prisma/client-valuation';
import { afterAll, describe, expect, it } from 'vitest';

const target = new URL(process.env.DATABASE_URL!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Proxy {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  port = 0;
  async up(): Promise<void> {
    const server = createServer((client) => {
      const upstream = connect(Number(target.port || 5432), target.hostname);
      for (const s of [client, upstream]) { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); s.on('error', () => s.destroy()); }
      client.pipe(upstream); upstream.pipe(client);
    });
    await new Promise<void>((resolve) => server.listen(this.port, '127.0.0.1', resolve));
    this.port = (server.address() as { port: number }).port;
    this.server = server;
  }
  /** Simulates the DB going away: drop every live connection and refuse new ones. */
  async down(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }
  url(): string {
    const u = new URL(target.toString());
    u.hostname = '127.0.0.1'; u.port = String(this.port);
    u.searchParams.set('connect_timeout', '2'); u.searchParams.set('pool_timeout', '2');
    return u.toString();
  }
}

const ping = (db: PrismaClient) => db.$queryRawUnsafe<{ one: number }[]>('SELECT 1::int AS one');

describe('M8: Prisma reconnects after a DB outage (no restart)', () => {
  const proxy = new Proxy();
  let db: PrismaClient | undefined;
  afterAll(async () => { await db?.$disconnect().catch(() => undefined); await proxy.down(); });

  it('startup connect retries while the DB is down and succeeds once it is back', async () => {
    await proxy.up(); const url = proxy.url(); await proxy.down(); // reserve a port, then go dark
    db = new PrismaClient({ datasources: { db: { url } }, log: [] });
    const restore = sleep(1500).then(() => proxy.up());
    await connectWithRetry(() => db!.$connect(), { initialDelayMs: 200, maxDelayMs: 500, maxWaitMs: 15_000 });
    await restore;
    expect(await ping(db)).toEqual([{ one: 1 }]);
  }, 30_000);

  it('a query during the outage fails with a transient error; queries succeed again after the DB returns, on the same client', async () => {
    expect(await ping(db!)).toEqual([{ one: 1 }]);
    await proxy.down();
    const failure = await ping(db!).then(() => null, (e: unknown) => e);
    expect(failure).not.toBeNull();
    expect(isTransientDbError(failure)).toBe(true);
    await proxy.up();
    // No $connect(), no new client: the first query after recovery should already work; allow a short grace period for the pool.
    let recovered: unknown = null;
    for (let i = 0; i < 20 && !recovered; i++) {
      recovered = await ping(db!).catch(async () => { await sleep(250); return null; });
    }
    expect(recovered).toEqual([{ one: 1 }]);
  }, 30_000);
});
