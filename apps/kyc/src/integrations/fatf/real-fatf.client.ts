// RealFatfClient: FATF-ийн өндөр эрсдэлтэй юрисдикцийн жагсаалтыг FATF_LIST_FILE-аас уншина (FATF-д machine-readable API байхгүй).
// Файлыг үйл ажиллагааны баг бүрэн хуралдаан бүрийн дараа шинэчилнэ — формат, журам: ./README.md. Хатуу шалгалт: ./fatf-list.ts.
import { ExternalListError } from '../errors';
import type { FatfClient, FatfSnapshot } from './fatf.client';
import { parseFatfList, readFatfListFile } from './fatf-list';
import { loadFatfConfig } from './fatf.config';

type Env = Record<string, string | undefined>;

export interface RealFatfOptions { env?: Env }

export class RealFatfClient implements FatfClient {
  constructor(private readonly options: RealFatfOptions = {}) {}

  async fetchSnapshot(signal?: AbortSignal): Promise<FatfSnapshot> {
    const { listFile } = loadFatfConfig(this.options.env ?? process.env); // тохируулаагүй бол IntegrationNotConfiguredError (fail closed)
    if (signal?.aborted) throw new ExternalListError('fatf', 'read aborted');
    return parseFatfList(readFatfListFile(listFile));
  }
}
