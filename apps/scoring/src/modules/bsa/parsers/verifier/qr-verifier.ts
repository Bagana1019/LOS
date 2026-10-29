// QR баталгаажуулалтын port (BSA-FR-2.3). Банк бүрийн QR-г тухайн банкны verification endpoint-оор л жинхэнэ шалгана.
// TODO(bank API): бодит хэрэгжүүлэлт нь банк бүрийн баталгаажуулах endpoint, итгэмжлэл (credentials), гэрээ шаардана — энэ нь
// хүний оролцоотой (human-in-the-loop) зүйл; хэрэгжтэл NullQrVerifier (null = шалгаагүй) ашиглана, мөн QR_NOT_VERIFIED анхааруулга гарна.
import { Injectable } from '@nestjs/common';

export interface QrVerifier {
  /**
   * @returns true = банкны талаас баталгаажсан; false = банк татгалзсан/таарсангүй; null = шалгаж чадсангүй (endpoint байхгүй, QR алга).
   * payload-ууд нь хэрэглэгчийн баримтаас гарсан тул лог руу бичихгүй.
   */
  verify(payloads: string[]): Promise<boolean | null>;
}

export const QR_VERIFIER = Symbol('QR_VERIFIER');

@Injectable()
export class NullQrVerifier implements QrVerifier {
  async verify(_payloads: string[]): Promise<boolean | null> {
    return null;
  }
}
