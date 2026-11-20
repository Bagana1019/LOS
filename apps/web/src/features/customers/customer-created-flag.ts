// F1-15: бүртгэсний дараа картад тогтвортой амжилтын мэдэгдэл харуулах тэмдэг. Toast 3 секундэд арилдаг бол карт руу шилжих нь (dev-д маршрут compile, удаан сүлжээ)
// 3 секундээс удаж болно — тэгвэл хэрэглэгч амжилтын ямар ч мөр харахгүй. Тэмдэг нь зөвхөн харилцагчийн id (хувийн мэдээлэлгүй), нэг удаа уншигдаад устна.
const KEY = 'los.customer.justCreated';
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const sessionStore = (): Store | null => {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null; // хориглосон хадгалалт (privacy горим): toast л үлдэнэ
  }
};

export function markCustomerCreated(id: string, store: Store | null = sessionStore()): void {
  try {
    store?.setItem(KEY, id);
  } catch {
    // хадгалалт дүүрсэн/хаалттай: мэдэгдэл нь зөвхөн сайжруулалт, бүртгэл амжилттай тул үргэлжилнэ
  }
}

/** Тухайн харилцагчийн тэмдэг байвал `true` буцааж, тэмдгийг устгана (дахин нээхэд баннер гарахгүй). */
export function consumeCustomerCreated(id: string, store: Store | null = sessionStore()): boolean {
  try {
    if (!store || store.getItem(KEY) !== id) return false;
    store.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
