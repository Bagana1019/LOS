import { Readable } from 'node:stream';
import { Client } from 'minio';

/** Объект хадгалалтын абстракц: бодит нь MinIO (S3), тестэд санах ой. `STORAGE_DRIVER=minio|memory`. */
export interface ObjectStorage {
  readonly bucket: string;
  ensureBucket(): Promise<void>;
  put(key: string, body: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
  ping(): Promise<void>;
}
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export class MinioStorage implements ObjectStorage {
  private readonly client: Client;
  constructor(readonly bucket: string, env: NodeJS.ProcessEnv = process.env) {
    const accessKey = env.MINIO_ACCESS_KEY;
    const secretKey = env.MINIO_SECRET_KEY;
    if (!accessKey || !secretKey) throw new Error('MINIO_ACCESS_KEY and MINIO_SECRET_KEY are required (see .env.example)');
    this.client = new Client({ endPoint: env.MINIO_ENDPOINT ?? 'localhost', port: Number(env.MINIO_PORT ?? 9000), useSSL: env.MINIO_USE_SSL === 'true', accessKey, secretKey });
  }
  async ensureBucket() { if (!(await this.client.bucketExists(this.bucket))) await this.client.makeBucket(this.bucket); }
  async put(key: string, body: Buffer, mime: string) { await this.client.putObject(this.bucket, key, body, body.length, { 'Content-Type': mime }); }
  get(key: string) { return this.client.getObject(this.bucket, key); }
  async remove(key: string) { await this.client.removeObject(this.bucket, key); }
  async ping() { await this.client.bucketExists(this.bucket); }
}

export class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, Buffer>();
  constructor(readonly bucket = 'memory') {}
  async ensureBucket() {}
  async put(key: string, body: Buffer) { this.objects.set(key, Buffer.from(body)); }
  async get(key: string) {
    const b = this.objects.get(key);
    if (!b) throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' });
    return Readable.from([b]);
  }
  async remove(key: string) { this.objects.delete(key); }
  async ping() {}
}

export function createStorage(env: NodeJS.ProcessEnv = process.env): ObjectStorage {
  return (env.STORAGE_DRIVER ?? 'minio') === 'memory' ? new MemoryStorage() : new MinioStorage(env.MINIO_BUCKET ?? 'los-files', env);
}
