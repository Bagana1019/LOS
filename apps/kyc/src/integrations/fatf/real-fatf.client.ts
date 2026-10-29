import { IntegrationNotImplementedError } from '../errors';
import type { FatfClient, FatfSnapshot } from './fatf.client';

export interface RealFatfConfig {
  /** Dataset эсвэл гараар байршуулсан файлын хаяг (FATF-д machine-readable API байхгүй). */
  url?: string;
}

/**
 * TODO(human): FATF-ийн өндөр эрсдэлтэй юрисдикцийн жагсаалтыг бодитоор авах.
 *  FATF нь machine-readable API өгдөггүй тул хоёрын нэгийг сонгоно:
 *   (a) найдвартай засвар үйлчилгээтэй dataset-ээс татах (config.url), эсвэл
 *   (b) FATF-ийн бүрэн хуралдаан (plenary) бүрийн дараа жагсаалтыг гараар байршуулах (admin upload).
 *  Аль ч тохиолдолд: category (CALL_FOR_ACTION | INCREASED_MONITORING), улсын код ISO alpha-2 том үсгээр,
 *  version = plenary сар (жнь '2026-10'). Хоосон жагсаалтыг WatchlistService татгалзана.
 *  Урьдчилсан нөхцөл: сүлжээний allow-list болон хууль зүйн хяналт.
 */
export class RealFatfClient implements FatfClient {
  readonly url?: string;

  constructor(config: RealFatfConfig = {}) {
    this.url = config.url;
  }

  async fetchSnapshot(): Promise<FatfSnapshot> {
    throw new IntegrationNotImplementedError('fatf');
  }
}
