import type { z } from 'zod';
import { SigningRequestView } from '@los/contracts';

/**
 * Ажилтны client-д буцах хариу = dms-ийн SigningRequestView − signingUrl.
 * Линк нь зөвхөн SMS-ээр зээлдэгчид очно; ажилтан (эсвэл түүний browser/лог) токеныг хэзээ ч харахгүй тул
 * `signingUrl`-ийг schema-аар (strip) хасна — гараар `delete` хийхээс найдвартай.
 */
export const StaffSigningRequestView = SigningRequestView.omit({ signingUrl: true });
export type StaffSigningRequestView = z.infer<typeof StaffSigningRequestView>;

export function toStaffView(view: SigningRequestView): StaffSigningRequestView {
  return StaffSigningRequestView.parse(view);
}
