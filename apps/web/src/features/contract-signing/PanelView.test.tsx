import { renderToString } from 'react-dom/server';
import { SigningStatus } from '@los/contracts';
import { describe, expect, it, vi } from 'vitest';
import { buttonByText, buttons, visibleText } from '../esign/testing/html';
import { staffViewFixture, TOKEN } from '../esign/testing/fixtures';
import { ContractSigningPanel } from './ContractSigningPanel';
import * as barrel from './index';
import { PanelView, type PanelViewProps } from './PanelView';
import type { StaffSigningView } from './api';

function props(overrides: Partial<PanelViewProps> = {}): PanelViewProps {
  return {
    view: null,
    loading: false,
    busy: false,
    notice: null,
    error: null,
    preferred: null,
    onPreferredChange: vi.fn(),
    onSend: vi.fn(),
    onResend: vi.fn(),
    onCancel: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
}

const render = (overrides: Partial<PanelViewProps> = {}) => renderToString(<PanelView {...props(overrides)} />);
const labels = (html: string) => buttons(html).map((b) => b.text);

describe('PanelView — товчнууд төлөв бүрт', () => {
  it('хүсэлт байхгүй: "Тоон гарын үсгээр илгээх" + үйлчилгээ сонгох; resend/cancel байхгүй', () => {
    const html = render();
    const text = visibleText(html);
    expect(text).toContain('Илгээгээгүй');
    expect(text).toContain('Зээлдэгч өөрөө сонгоно');
    expect(labels(html)).toContain('Тоон гарын үсгээр илгээх');
    expect(labels(html)).not.toContain('Дахин илгээх');
    expect(labels(html)).not.toContain('Цуцлах');
  });

  it.each(['PENDING', 'IN_PROGRESS'] as const)('%s: "Дахин илгээх" + "Цуцлах"; шинээр илгээх байхгүй', (status) => {
    const html = render({ view: staffViewFixture({ status, provider: status === 'IN_PROGRESS' ? 'TRIDUM' : null }) });
    expect(labels(html)).toEqual(expect.arrayContaining(['Дахин илгээх', 'Цуцлах']));
    expect(labels(html)).not.toContain('Тоон гарын үсгээр илгээх');
    expect(buttonByText(html, 'Цуцлах')?.disabled).toBe(false);
  });

  it('FINALIZING: ямар ч үйлдэл байхгүй (түр түгжээ), тайлбартай', () => {
    const html = render({ view: staffViewFixture({ status: 'FINALIZING', provider: 'TRIDUM' }) });
    expect(labels(html).filter((l) => l !== 'Шинэчлэх')).toEqual([]);
    expect(visibleText(html)).toContain('Гарын үсгийг баталгаажуулж байна');
  });

  it('SIGNED: код XXXX-XXXX-XXXX, огноо UB цагаар; үйлдэл байхгүй', () => {
    const view = staffViewFixture({ status: 'SIGNED', provider: 'MONPASS', signedAt: '2026-10-28T06:05:09.000Z', verificationCode: '7K3M9QZ4T8VX' });
    const html = render({ view });
    const text = visibleText(html);
    expect(text).toContain('Гарын үсэг зурагдсан');
    expect(text).toContain('7K3M-9QZ4-T8VX');
    expect(text).toContain('2026-10-28 14:05:09');
    expect(text).toContain('Monpass');
    expect(labels(html).filter((l) => l !== 'Шинэчлэх')).toEqual([]);
  });

  it.each(['DECLINED', 'EXPIRED', 'FAILED', 'CANCELLED'] as const)('%s: шинээр илгээж болно, resend/cancel байхгүй', (status) => {
    const html = render({ view: staffViewFixture({ status }) });
    expect(labels(html)).toContain('Тоон гарын үсгээр илгээх');
    expect(labels(html)).not.toContain('Дахин илгээх');
    expect(labels(html)).not.toContain('Цуцлах');
  });

  it('FAILED: шалтгааныг ажилтанд харуулна', () => {
    const text = visibleText(render({ view: staffViewFixture({ status: 'FAILED', failureReason: 'IDENTITY_MISMATCH' }) }));
    expect(text).toContain('Регистр гарын үсгийн гэрчилгээтэй таараагүй');
  });

  it('аль нэг үйлдэл явагдаж байхад товчнууд түгжигдэнэ', () => {
    const html = render({ view: staffViewFixture({ status: 'PENDING' }), busy: true });
    expect(buttonByText(html, 'Дахин илгээх')?.disabled).toBe(true);
    expect(buttonByText(html, 'Цуцлах')?.disabled).toBe(true);
    expect(buttonByText(html, 'Шинэчлэх')?.disabled).toBe(true);
  });

  it('ачаалж байхад төлөв/товч харуулахгүй', () => {
    const html = render({ loading: true });
    expect(visibleText(html)).toContain('Ачаалж байна…');
    expect(labels(html)).not.toContain('Тоон гарын үсгээр илгээх');
  });

  it('амжилтын мэдэгдэл, алдааг харуулна', () => {
    const html = render({ notice: 'Холбоосыг зээлдэгчийн утас руу SMS-ээр илгээлээ.', error: 'Хүсэлт батлагдаагүй тул гэрээнд гарын үсэг зурах боломжгүй' });
    expect(html).toContain('ant-alert-success');
    expect(html).toContain('ant-alert-error');
    expect(visibleText(html)).toContain('Хүсэлт батлагдаагүй');
  });

  it('утасны дугаар далдалсан хэлбэрээр; бүртгэлийн ID-нууд (id, orgId…) харагдахгүй', () => {
    const text = visibleText(render({ view: staffViewFixture() }));
    expect(text).toContain('+976 ****2233');
    expect(text).toContain('Б. Болд');
    for (const hidden of ['req-1', 'org-1', 'ctr-1', 'cus-1']) expect(text).not.toContain(hidden);
  });
});

describe('PanelView — зээлдэгчийн линк хэзээ ч харагдахгүй', () => {
  it('view-д (буруугаар) signingUrl орж ирсэн ч HTML-д гарахгүй', () => {
    const leaked = { ...staffViewFixture(), signingUrl: `https://los.example/sign/${TOKEN}` } as unknown as StaffSigningView;
    for (const status of SigningStatus) {
      const html = render({ view: { ...leaked, status } });
      expect(html, status).not.toContain(TOKEN);
      expect(html, status).not.toContain('/sign/');
    }
  });
});

describe('ContractSigningPanel', () => {
  it('SSR: өөрийн QueryClient-тэй, ачаалж байна', () => {
    const html = renderToString(<ContractSigningPanel applicationId="app-1" />);
    expect(visibleText(html)).toContain('Цахим гарын үсэг (цаасгүй гэрээ)');
    expect(visibleText(html)).toContain('Ачаалж байна…');
  });

  it('features/contract-signing/index.ts-ээс экспортлогдоно', () => {
    expect(barrel.ContractSigningPanel).toBe(ContractSigningPanel);
  });
});
