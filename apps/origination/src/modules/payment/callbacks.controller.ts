import { Body, Controller, Get, Header, HttpCode, Logger, Post, Query } from '@nestjs/common';
import { PaymentCallbackParams } from '@los/contracts';
import { Public } from '@los/nest-common';
import { InvoiceService } from './invoice.service';
import { safeLogText } from './payment.errors';

type Raw = Record<string, unknown> | undefined;
const pick = (...sources: Raw[]) => (key: string): string | undefined => {
  for (const s of sources) { const v = s?.[key]; if (typeof v === 'string' && v.trim()) return v.trim(); }
  return undefined;
};

/**
 * Провайдерийн callback. @Public() — gateway-ийн auth байхгүй, rate-limit gateway-д. Агуулгад ИТГЭХГҮЙ:
 * зөвхөн `invoice` (манай senderInvoiceNo)-г аваад InvoiceService.handleCallback → checkInvoice-ээр баталгаажуулна.
 * Үргэлж 200 `SUCCESS` — провайдерын дахин оролдлогыг хаана; алдагдсан төлбөрийг poll (GET invoice / maintenance) нөхнө.
 */
@Controller()
export class CallbacksController {
  private readonly logger = new Logger('PaymentCallbacks');
  constructor(private readonly invoices: InvoiceService) {}

  @Public() @Get('payments/callbacks/qpay') @HttpCode(200) @Header('Content-Type', 'text/plain; charset=utf-8')
  qpayGet(@Query() query: Raw): Promise<string> { return this.handle('QPAY', pick(query)); }

  @Public() @Post('payments/callbacks/qpay') @HttpCode(200) @Header('Content-Type', 'text/plain; charset=utf-8')
  qpayPost(@Query() query: Raw, @Body() body: Raw): Promise<string> { return this.handle('QPAY', pick(query, body)); }

  @Public() @Post('payments/callbacks/socialpay') @HttpCode(200) @Header('Content-Type', 'text/plain; charset=utf-8')
  socialpay(@Query() query: Raw, @Body() body: Raw): Promise<string> { return this.handle('SOCIALPAY', pick(query, body)); }

  private async handle(provider: 'QPAY' | 'SOCIALPAY', get: (key: string) => string | undefined): Promise<string> {
    const parsed = PaymentCallbackParams.safeParse({ invoice: get('invoice') ?? get('sender_invoice_no') ?? get('senderInvoiceNo') });
    if (!parsed.success) {
      this.logger.warn(`${provider} callback: invoice параметр буруу/дутуу`);
      return 'SUCCESS';
    }
    try {
      await this.invoices.handleCallback(provider, parsed.data.invoice);
    } catch (e) {
      this.logger.error(`${provider} callback боловсруулахад алдаа (${safeLogText(parsed.data.invoice)}): ${e instanceof Error ? safeLogText(e.message, 120) : 'үл мэдэгдэх'}`);
    }
    return 'SUCCESS';
  }
}
