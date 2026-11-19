// M10 — аудитын DLQ (los:gateway:audit:dlq) шалгах / буцаах жижиг CLI. Build-ийн дараа:
//   pnpm --filter gateway audit:dlq list [n]     — id, errorClass, failedAt (payload хэвлэхгүй)
//   pnpm --filter gateway audit:dlq replay [n]   — шалтгааныг зассаны дараа хамгийн хуучин n мөрийг fallback дараалалд буцаана (drain DB руу бичнэ)
import Redis from 'ioredis';
import { RedisAuditQueue } from './audit-fallback-queue';

async function main(argv: string[]): Promise<number> {
  const [cmd = 'list', nRaw = '50'] = argv;
  const n = Math.max(1, Math.min(10_000, Number(nRaw) || 50));
  const url = process.env.REDIS_URL?.trim();
  if (!url) { process.stderr.write('REDIS_URL is required\n'); return 2; }
  const redis = new Redis(url, { maxRetriesPerRequest: 1 });
  try {
    const q = new RedisAuditQueue(redis);
    if (cmd === 'list') {
      for (const d of await q.deadLetters(n)) process.stdout.write(`${d.failedAt}\t${d.errorClass}\t${d.id ?? '-'}\n`);
      return 0;
    }
    if (cmd === 'replay') { process.stdout.write(`replayed ${await q.replayDeadLetters(n)}\n`); return 0; }
    process.stderr.write('usage: audit-dlq list|replay [n]\n');
    return 2;
  } finally {
    redis.disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });
}
