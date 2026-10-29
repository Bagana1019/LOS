import { PortalCreatePaymentCommand, PortalPaymentListQuery } from '@los/contracts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ERROR_CATALOG } from '../common/error-catalog';
import { PortalError } from '../common/portal-error';
import type { Clock } from '../common/clock';
import { MockLedger } from '../integrations/mock/mock-ledger';

export interface Received {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

/**
 * origination-ы `/api/internal/portal/*` (docs/05-portal-bff.md §6) гэрээг MockLedger дээр хэрэгжүүлсэн ЖИЖИГ сервер.
 * Real adapter-ууд ба HTTP клиентийг (header, timeout, retry, zod шалгалт, stream) жинхэнэ сүлжээгээр туршихад хэрэглэнэ,
 * мөн origination талыг хэрэгжүүлэгчид лавлах жишээ болно.
 */
export class FakeOrigination {
  readonly ledger: MockLedger;
  readonly received: Received[] = [];
  readonly otpCodes = new Map<string, string>();
  /** Тест: path-ийн regexp-д таарвал заасан хариуг (status, body) шууд буцаана. */
  overrides: Array<{ match: RegExp; times: number; respond: (res: ServerResponse) => void }> = [];
  private server!: Server;
  url = '';

  constructor(clock: Clock, opts: { timezone?: string; paymentConfirmMs?: number } = {}) {
    this.ledger = new MockLedger(clock, { timezone: opts.timezone ?? 'Asia/Ulaanbaatar', paymentConfirmMs: opts.paymentConfirmMs ?? 1000 });
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = await readBody(req);
    this.received.push({ method: req.method ?? '', path: url.pathname + url.search, headers: req.headers, body });

    const override = this.overrides.find((o) => o.times > 0 && o.match.test(url.pathname));
    if (override) {
      override.times--;
      return override.respond(res);
    }

    try {
      await this.route(req, url, body, res);
    } catch (err) {
      if (err instanceof PortalError) {
        const { status } = ERROR_CATALOG[err.code];
        return json(res, status, { error: { code: err.code } });
      }
      return json(res, 500, { error: { code: 'INTERNAL' } });
    }
  }

  private async route(req: IncomingMessage, url: URL, body: unknown, res: ServerResponse): Promise<void> {
    const prefix = '/api/internal/portal';
    if (!url.pathname.startsWith(prefix)) return json(res, 404, {});
    const path = url.pathname.slice(prefix.length);
    const customerId = header(req, 'x-customer-id');
    const m = req.method;
    let r: RegExpMatchArray | null;

    if (m === 'POST' && path === '/customers/lookup') {
      const { registerNo, phone } = body as { registerNo: string; phone: string };
      const found = this.ledger.findCustomer(registerNo, phone);
      return found ? json(res, 200, found) : json(res, 404, { error: { code: 'NOT_FOUND' } });
    }
    if (m === 'POST' && path === '/otp') {
      this.otpCodes.set(required(customerId), (body as { code: string }).code);
      return json(res, 202, {});
    }
    const cid = required(customerId);
    if (m === 'GET' && path === '/customers/me') return json(res, 200, this.ledger.profile(cid));
    if (m === 'GET' && path === '/loans') return json(res, 200, this.ledger.listLoans(cid));
    if (m === 'GET' && (r = path.match(/^\/loans\/([^/]+)$/))) return json(res, 200, this.ledger.getLoan(cid, r[1]));
    if (m === 'GET' && (r = path.match(/^\/loans\/([^/]+)\/balance$/))) return json(res, 200, this.ledger.getBalance(cid, r[1]));
    if (m === 'GET' && (r = path.match(/^\/loans\/([^/]+)\/schedule$/))) return json(res, 200, this.ledger.getSchedule(cid, r[1]));
    if (m === 'GET' && (r = path.match(/^\/loans\/([^/]+)\/contract$/))) return json(res, 200, this.ledger.contractInfo(cid, r[1]));
    if (m === 'GET' && (r = path.match(/^\/loans\/([^/]+)\/contract\/content$/))) {
      const pdf = this.ledger.contractPdf(cid, r[1]);
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length });
      return void res.end(pdf);
    }
    if (m === 'GET' && (r = path.match(/^\/loans\/([^/]+)\/payment-methods$/))) return json(res, 200, this.ledger.methods(cid, r[1]));
    if (m === 'POST' && (r = path.match(/^\/loans\/([^/]+)\/payments$/))) {
      const cmd = PortalCreatePaymentCommand.parse(body);
      if (cmd.loanId !== r[1]) return json(res, 400, { error: { code: 'INVALID_REQUEST' } });
      return json(res, 201, this.ledger.createPayment(cid, cmd, required(header(req, 'idempotency-key'))));
    }
    if (m === 'GET' && (r = path.match(/^\/loans\/([^/]+)\/payments$/))) {
      const query = PortalPaymentListQuery.parse(Object.fromEntries(url.searchParams));
      return json(res, 200, this.ledger.listPayments(cid, r[1], query));
    }
    if (m === 'GET' && (r = path.match(/^\/payments\/([^/]+)$/))) return json(res, 200, this.ledger.getPayment(cid, r[1]));
    return json(res, 404, {});
  }
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

function required<T>(v: T | undefined): T {
  if (v === undefined) throw new PortalError('UNAUTHENTICATED');
  return v;
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
