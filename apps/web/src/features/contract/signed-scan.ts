// F4-13: гарын үсэгтэй гэрээний скан зөвхөн PDF / PNG / JPG. Сервер (origination) мөн л 415 SIGNED_SCAN_TYPE_NOT_ALLOWED-ээр татгалзана,
// гэхдээ тэр үед файл DMS-д орчихсон байдаг тул клиент дээр байршуулахаас ӨМНӨ шалгана.

/** `<input accept>`: хөтөчийн файл сонгогчийг хязгаарлана (зөвхөн сануулга — эцсийн шалгалт доорх `isSignedScanFile` ба сервер дээр). */
export const SIGNED_SCAN_ACCEPT = '.pdf,.png,.jpg,.jpeg';

/** origination-ийн алдааны код (HTTP 415). */
export const SIGNED_SCAN_ERROR_CODE = 'SIGNED_SCAN_TYPE_NOT_ALLOWED';

const EXTENSIONS: ReadonlySet<string> = new Set(['pdf', 'png', 'jpg', 'jpeg']);
const MIME_TYPES: ReadonlySet<string> = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg']);

/**
 * Сүүлийн өргөтгөл (том/жижиг үсэг үл ялгана) зөвшөөрөгдсөн байх ёстой. Хөтөч MIME өгсөн бол тэр ч зөвшөөрөгдсөн байна
 * (`notes.pdf` нэртэй `text/plain`-ийг татгалзана). MIME хоосон (хөтөч мэдэхгүй) бол өргөтгөлөөр л шийднэ — агуулгыг сервер шалгана.
 */
export function isSignedScanFile(file: { name: string; type?: string }): boolean {
  const dot = file.name.lastIndexOf('.');
  const extension = dot < 0 ? '' : file.name.slice(dot + 1).toLowerCase();
  if (!EXTENSIONS.has(extension)) return false;
  const type = (file.type ?? '').toLowerCase();
  return type === '' || MIME_TYPES.has(type);
}

/** Сервер төрлийг нь татгалзсан (415) эсэх. */
export function isSignedScanTypeError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === SIGNED_SCAN_ERROR_CODE;
}
