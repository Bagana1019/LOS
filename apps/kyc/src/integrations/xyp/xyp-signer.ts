// ХУР-ын хүсэлтийн гарын үсэг. gsb (mini_service/xyp_service/xyp_sign.py, xyp_client.py)-ээр нотлогдсон:
//   signature = base64( RSASSA-PKCS1-v1_5 · SHA-256 ( "<accessToken>.<timeStamp>" ) ), timeStamp = epoch секунд (бүхэл, string).
// accessToken, timeStamp, signature гурвыг HTTP header-ээр илгээнэ (SOAP header биш). Nonce, payload шифрлэлт байхгүй (зөвхөн TLS).
// Түлхүүр нь ҮДТ-ийн олгосон RSA хувийн түлхүүр: Python `RSA.importKey`-тэй адил PEM/DER, PKCS#1/PKCS#8-ийг хүлээн авна.
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';

export interface XypSignature {
  accessToken: string;
  timeStamp: string;
  signature: string;
}

/** Түлхүүрийн агуулгыг алдаанд оруулахгүй. */
const INVALID_KEY = 'XYP private key must be an RSA private key (PEM or DER, PKCS#1 or PKCS#8)';

export function loadXypPrivateKey(material: Buffer): KeyObject {
  const attempts: Array<() => KeyObject> = [
    () => createPrivateKey(material), // PEM (PKCS#1 / PKCS#8)
    () => createPrivateKey({ key: material, format: 'der', type: 'pkcs8' }),
    () => createPrivateKey({ key: material, format: 'der', type: 'pkcs1' }),
  ];
  for (const attempt of attempts) {
    try {
      const key = attempt();
      if (key.asymmetricKeyType === 'rsa') return key;
    } catch {
      /* дараагийн хэлбэрийг оролдоно */
    }
  }
  throw new Error(INVALID_KEY);
}

/** Дуудлага бүрд шинээр зурна (gsb-тэй адил). `nowMs` инжект хийгдэнэ → тест тодорхойлогдох. */
export function signXypRequest(input: { accessToken: string; privateKey: KeyObject; nowMs: number }): XypSignature {
  const timeStamp = String(Math.floor(input.nowMs / 1000));
  const signature = createSign('RSA-SHA256').update(`${input.accessToken}.${timeStamp}`, 'utf8').sign(input.privateKey, 'base64');
  return { accessToken: input.accessToken, timeStamp, signature };
}
