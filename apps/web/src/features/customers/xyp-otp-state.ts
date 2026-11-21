/** Серверийн кодууд (origination xyp-consent): оролдлого дууссан / хүчинтэй код байхгүй → ЭНЭ кодоор дахин баталгаажуулах боломжгүй. */
const UNUSABLE_CODES: ReadonlySet<string> = new Set(['XYP_OTP_ATTEMPTS_EXHAUSTED', 'XYP_OTP_NOT_REQUESTED']);

/** F1-7: true бол баталгаажуулах товч идэвхгүй болно; хэрэглэгч шинэ код авна. Буруу код (XYP_OTP_INVALID) үед дахин оролдож болно. */
export const isOtpCodeUnusable = (code: string | null | undefined): boolean => !!code && UNUSABLE_CODES.has(code);
