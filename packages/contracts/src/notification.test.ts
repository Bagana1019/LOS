import { describe, expect, it } from 'vitest';
import { NotificationType } from './enums';
import { NotificationView } from './dto/notification';

// F5-12: олголтын илгээх/татгалзах (4 нүд) нь батлагч/ЗЭЗ-д хонхны мэдэгдэл үүсгэх ёстой.
const view = (type: string) => ({ id: 'n1', type, applicationId: 'app-1', title: 'Олголт', body: 'APP-1', payload: {}, readAt: null, createdAt: '2026-11-20T09:05:00.000Z' });

describe('NotificationType — олголтын мэдэгдлийн төрлүүд (F5-12)', () => {
  it('илгээсэн ба татгалзсан төрөл enum-д бий', () => {
    expect(NotificationType).toContain('DISBURSEMENT_SUBMITTED');
    expect(NotificationType).toContain('DISBURSEMENT_REJECTED');
  });

  it('одоо байгаа төрлүүд өөрчлөгдөөгүй (DISBURSEMENT_APPROVED хэвээр, давхардалгүй)', () => {
    for (const t of ['APPROVAL_REQUESTED', 'RETURNED', 'APPROVED', 'DISBURSEMENT_APPROVED', 'SLA_BREACH', 'MENTION', 'PAYMENT_DUE', 'PAYMENT_OVERDUE', 'PAYMENT_RECEIVED']) expect(NotificationType).toContain(t);
    expect(new Set(NotificationType).size).toBe(NotificationType.length);
  });

  it('NotificationView шинэ төрлийг хүлээн авна, үл мэдэгдэх төрлийг татгалзана', () => {
    expect(NotificationView.parse(view('DISBURSEMENT_SUBMITTED')).type).toBe('DISBURSEMENT_SUBMITTED');
    expect(NotificationView.parse(view('DISBURSEMENT_REJECTED')).type).toBe('DISBURSEMENT_REJECTED');
    expect(NotificationView.safeParse(view('DISBURSEMENT_UNKNOWN')).success).toBe(false);
  });
});
