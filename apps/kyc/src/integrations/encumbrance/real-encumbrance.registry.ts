import type { EncumbranceSourceResult } from '@los/contracts';
import { IntegrationNotImplementedError } from '../errors';
import type { EncumbranceAssetType, EncumbranceRegistry } from './encumbrance.registry';

export interface RealEncumbranceConfig {
  zmsBaseUrl?: string;
  ebBaseUrl?: string;
}

/**
 * TODO(human): ЗМС (зээлийн мэдээллийн сан) ба ЭБ (барьцаа хөрөнгийн бүртгэл)-ийн бодит холболт.
 *  Хэрэгтэй: хоёр бүртгэлийн хандалтын гэрээ, API баримт (түлхүүр: улсын дугаар / өмчлөх эрхийн дугаар / серийн дугаар хэрхэн дамжих,
 *  хариуны талбар, алдааны утга), ББСБ-ын эрх/сертификат, сүлжээний allow-list. Endpoint, талбарын нэрийг ТААМАГЛАХГҮЙ.
 *  Хэрэгжүүлэхдээ: хоёр эх сурвалжийг зэрэг дуудаж `EncumbranceSourceResult[]` болгоно; аль нэг нь унавал `EncumbranceUnavailableError`
 *  (хэсэгчилсэн хариу буцаахгүй — fail closed). Дугаарыг лог-д бичихгүй (CLAUDE.md §6.5).
 */
export class RealEncumbranceRegistry implements EncumbranceRegistry {
  readonly config: RealEncumbranceConfig;

  constructor(config: RealEncumbranceConfig = {}) {
    this.config = config;
  }

  async check(_assetType: EncumbranceAssetType, _identifier: string): Promise<EncumbranceSourceResult[]> {
    throw new IntegrationNotImplementedError('encumbrance');
  }
}
