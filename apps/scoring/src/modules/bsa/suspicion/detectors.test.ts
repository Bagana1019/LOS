// docs/02 §5: 8 дохионы detector. SYNTHETIC өгөгдөл; босго нь DEFAULT_BSA_SETTINGS.suspicion (DEMO).
import { describe, expect, it } from 'vitest';
import { DEFAULT_BSA_SETTINGS } from '../common/settings';
import {
  detectCircular, detectCollusion, detectGambling, detectInterAccountFraud, detectOwnAccount, detectQuickCash, detectSplitWithdrawal, detectStructuring,
  detectSuspicions, suspicionKey, toMillis, type SuspicionTxn,
} from './detectors';

const TH = DEFAULT_BSA_SETTINGS.suspicion;
let n = 0;
const t = (o: Partial<SuspicionTxn> & Pick<SuspicionTxn, 'direction' | 'amount' | 'txnDate'>): SuspicionTxn => ({
  id: `t${++n}`, txnTime: '10:00:00', description: 'Шилжүүлэг', counterpartyAccount: null, counterpartyName: null, channel: 'TRANSFER', isOwnTransfer: false, ...o,
});
const inc = (date: string, amount: number, o: Partial<SuspicionTxn> = {}) => t({ direction: 'INCOME', txnDate: date, amount, ...o });
const exp = (date: string, amount: number, o: Partial<SuspicionTxn> = {}) => t({ direction: 'EXPENSE', txnDate: date, amount, ...o });

describe('detectors', () => {
  it('toMillis: цаггүй бол өдрийн эхлэл', () => {
    expect(toMillis({ txnDate: '2026-05-01', txnTime: null })).toBe(Date.UTC(2026, 4, 1));
    expect(toMillis({ txnDate: '2026-05-01', txnTime: '01:30' })).toBe(Date.UTC(2026, 4, 1, 1, 30));
  });

  it('OWN_ACCOUNT: ижил өдөр+дүнтэй эсрэг хос нэг дохио, ганц нь тусдаа; автоматаар шийдвэрлэгдсэн', () => {
    const a = inc('2026-05-28', 500_000, { isOwnTransfer: true });
    const b = exp('2026-05-28', 500_000, { isOwnTransfer: true });
    const lone = inc('2026-06-01', 10_000, { isOwnTransfer: true });
    const r = detectOwnAccount([a, b, lone, inc('2026-06-02', 1)]);
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.autoResolved && x.flag === 'OWN_ACCOUNT')).toBe(true);
    expect(r.find((x) => x.transactionIds.length === 2)?.confidence).toBe(100);
  });

  it('CIRCULAR: орлого орж ирээд ойролцоо дүнтэй буцсан; өөр дүн/хугацаа хэтэрвэл үгүй', () => {
    const i = inc('2026-05-01', 1_000_000, { counterpartyAccount: 'A1' });
    const o = exp('2026-05-02', 1_010_000, { counterpartyAccount: 'A1' });
    const r = detectCircular([i, o], TH);
    expect(r).toHaveLength(1);
    expect(r[0]?.transactionIds.sort()).toEqual([i.id, o.id].sort());
    expect(r[0]?.confidence).toBeGreaterThan(75);
    expect(detectCircular([i, exp('2026-05-02', 1_500_000)], TH)).toHaveLength(0);
    expect(detectCircular([i, exp('2026-05-20', 1_000_000)], TH)).toHaveLength(0);
    expect(detectCircular([i, exp('2026-04-30', 1_000_000)], TH)).toHaveLength(0); // зарлага өмнө
    // өөр данстай ч илрэнэ, гэхдээ итгэл бага
    const other = detectCircular([i, exp('2026-05-01', 1_000_000, { txnTime: '12:00:00', counterpartyAccount: 'B2' })], TH);
    expect(other[0]?.confidence).toBeLessThan(75);
  });

  it('INTER_ACCOUNT_FRAUD: нэг дансны ≥3 тойрог хос', () => {
    const rows: SuspicionTxn[] = [];
    for (const d of ['01', '05', '09']) rows.push(inc(`2026-05-${d}`, 700_000, { counterpartyAccount: 'ZZ' }), exp(`2026-05-${d}`, 700_000, { txnTime: '15:00:00', counterpartyAccount: 'ZZ' }));
    const r = detectInterAccountFraud(rows, TH);
    expect(r).toHaveLength(1);
    expect(r[0]?.transactionIds).toHaveLength(6);
    expect(detectInterAccountFraud(rows.slice(0, 4), TH)).toHaveLength(0);
  });

  it('QUICK_CASH: орлогын дараа 24ц дотор ATM-ээр ≥80% авсан', () => {
    const i = inc('2026-05-01', 2_000_000);
    const a1 = exp('2026-05-01', 1_000_000, { txnTime: '12:00:00', channel: 'ATM' });
    const a2 = exp('2026-05-02', 700_000, { txnTime: '08:00:00', channel: 'ATM' });
    const r = detectQuickCash([i, a1, a2], TH);
    expect(r).toHaveLength(1);
    expect(r[0]?.transactionIds).toHaveLength(3);
    expect(detectQuickCash([i, a1], TH)).toHaveLength(0);
    expect(detectQuickCash([inc('2026-05-01', 500_000), exp('2026-05-01', 500_000, { txnTime: '12:00:00', channel: 'ATM' })], TH)).toHaveLength(0);
    // цаггүй хуулга: ижил өдөр
    expect(detectQuickCash([inc('2026-05-01', 2_000_000, { txnTime: null }), exp('2026-05-01', 1_900_000, { txnTime: null, channel: 'ATM' })], TH)).toHaveLength(1);
  });

  it('SPLIT_WITHDRAWAL: 24ц дотор ≥3 ATM авалт, нийлбэр ≥ босго', () => {
    const w = [400_000, 400_000, 400_000].map((a, k) => exp('2026-05-03', a, { txnTime: `1${k}:00:00`, channel: 'ATM' }));
    const r = detectSplitWithdrawal(w, TH);
    expect(r).toHaveLength(1);
    expect(detectSplitWithdrawal(w.slice(0, 2), TH)).toHaveLength(0);
    expect(detectSplitWithdrawal([...w.map((x) => ({ ...x, amount: 1000 }))], TH)).toHaveLength(0);
    const acc = [1, 2, 3].map(() => exp('2026-05-04', 500_000, { counterpartyAccount: 'Q9' }));
    expect(detectSplitWithdrawal(acc, TH)).toHaveLength(1);
  });

  it('COLLUSION: 7 хоногт ≥5 ялгаатай данснаас ойролцоо орлого', () => {
    const rows = ['A', 'B', 'C', 'D', 'E'].map((c, k) => inc(`2026-05-0${k + 1}`, 1_000_000 + k * 10_000, { counterpartyAccount: c }));
    expect(detectCollusion(rows, TH)).toHaveLength(1);
    expect(detectCollusion(rows.slice(0, 4), TH)).toHaveLength(0);
    const same = rows.map((r) => ({ ...r, counterpartyAccount: 'ONE' }));
    expect(detectCollusion(same, TH)).toHaveLength(0);
  });

  it('STRUCTURING: босгын ойролцоо (90–100%) ≥3 гүйлгээ 30 хоногт', () => {
    const rows = [19_000_000, 19_500_000, 18_500_000].map((a, k) => exp(`2026-05-1${k}`, a));
    const r = detectStructuring(rows, TH);
    expect(r).toHaveLength(1);
    expect(detectStructuring(rows.slice(0, 2), TH)).toHaveLength(0);
    expect(detectStructuring([...rows, exp('2026-05-20', 25_000_000)], TH)[0]?.transactionIds).toHaveLength(3);
  });

  it('GAMBLING: түлхүүр үг; богино латин үг өөр үгийн дотор таараагүй', () => {
    const g1 = exp('2026-05-01', 50_000, { description: 'Казино тоглоом' });
    const g2 = exp('2026-05-02', 50_000, { description: 'online BET payment' });
    const ok = exp('2026-05-03', 50_000, { description: 'alphabet school fee' });
    const r = detectGambling([g1, g2, ok], TH);
    expect(r.map((x) => x.transactionIds[0]).sort()).toEqual([g1.id, g2.id].sort());
    expect(detectGambling([g1], { ...TH, gamblingKeywords: [] })).toHaveLength(0);
  });

  it('detectSuspicions: өөрийн дансны гүйлгээг бусад дохионд оруулахгүй, түлхүүр тогтвортой, давхардахгүй', () => {
    const own1 = inc('2026-05-28', 20_000_000, { isOwnTransfer: true });
    const own2 = exp('2026-05-28', 20_000_000, { isOwnTransfer: true });
    const g = exp('2026-05-02', 1_000, { description: 'casino' });
    const all = [own1, own2, g];
    const a = detectSuspicions(all, TH);
    const b = detectSuspicions([...all].reverse(), TH);
    expect(a.map((x) => x.key)).toEqual(b.map((x) => x.key));
    expect(a.map((x) => x.flag).sort()).toEqual(['GAMBLING', 'OWN_ACCOUNT']);
    expect(suspicionKey('GAMBLING', ['b', 'a'])).toBe(suspicionKey('GAMBLING', ['a', 'b']));
    expect(suspicionKey('GAMBLING', ['a'])).not.toBe(suspicionKey('CIRCULAR', ['a']));
  });
});
