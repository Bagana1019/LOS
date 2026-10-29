import type { XypAssetsResponse, XypCitizen, XypPropertyAsset } from '@los/contracts';
import { IntegrationNotImplementedError } from '../errors';
import type { XypClient } from './xyp.client';

export interface RealXypConfig {
  baseUrl?: string;
}

/**
 * TODO(human): ХУР-ын бодит холболт (docs/04 "Хүний оролцоо" #1).
 *  Хэрэгтэй: ХУР-ын API баримт, ББСБ-ын эрх/сертификат, сүлжээний allow-list, хууль зүйн хяналт (хувийн мэдээлэл боловсруулах үндэслэл).
 *  Хэрэгжүүлэхдээ: иргэн (регистр → овог, нэр, хүйс, төрсөн огноо, хаяг, ам бүл, гэрлэлт) ба хуулийн этгээдийн сервисийг дуудаж `XypCitizen` болгон
 *  хөрвүүлнэ; хугацаа хэтэрвэл `XypUnavailableError`; олдохгүй бол `null`. Регистр, хариуг лог-д бичихгүй (CLAUDE.md §6.5).
 *  Хөрөнгө (FR-6.3, FR-6.5): үл хөдлөх хөрөнгийн өмчлөх эрхийн бүртгэл (регистрээр жагсаалт, өмчлөх эрхийн дугаараар өмчлөгчид) ба тээврийн хэрэгслийн
 *  бүртгэл (АТҮТ-ийг ХУР-ын гарцаар авах эсэхийг эхэлж шийднэ — apps/valuation/.../real-atut-vehicle-registry.ts). Endpoint/талбарын нэрийг таамаглахгүй.
 */
export class RealXypClient implements XypClient {
  readonly baseUrl?: string;

  constructor(config: RealXypConfig = {}) {
    this.baseUrl = config.baseUrl;
  }

  async getCitizen(_registerNo: string): Promise<XypCitizen | null> {
    throw new IntegrationNotImplementedError('xyp');
  }

  async getAssets(_registerNo: string): Promise<XypAssetsResponse | null> {
    throw new IntegrationNotImplementedError('xyp');
  }

  async getProperty(_propertyId: string): Promise<XypPropertyAsset | null> {
    throw new IntegrationNotImplementedError('xyp');
  }
}
