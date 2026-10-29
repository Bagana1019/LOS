// QrVerifier port, NullQrVerifier, StatementVerificationService. SYNTHETIC өгөгдөл.
import { describe, expect, it } from 'vitest';
import { BANK_PARSERS } from '../banks';
import { BANK_SPECS, bankStatement, specTransactions } from '../banks/testing/bank-specs';
import { StatementParserRegistry } from '../parser.registry';
import type { StatementFileMeta } from '../statement.types';
import { NullQrVerifier, QR_VERIFIER, type QrVerifier } from './qr-verifier';
import { StatementVerificationService } from './statement-verification.service';
import { baselineParsed, PDF_META } from './testing/baseline';

const registry = (): StatementParserRegistry => new StatementParserRegistry(BANK_PARSERS.map((C) => new C()));
const image: StatementFileMeta = { ...PDF_META, mimeType: 'image/png', pdf: undefined, qrPayloads: ['SYNTHETIC-QR-1', 'SYNTHETIC-QR-2'] };

/** Хаан зураг хүлээн авдаггүй тул (бодлого) зураг-тай тестэд өөр банкны хуулга ашиглана */
const golomtParsed = () => ({ ...baselineParsed(), bank: 'GOLOMT' as const });

class Spy implements QrVerifier {
  calls: string[][] = [];
  constructor(private readonly outcome: boolean | null | Error) {}
  async verify(payloads: string[]): Promise<boolean | null> {
    this.calls.push(payloads);
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

describe('NullQrVerifier', () => {
  it('never verifies anything (TODO(bank API)): always null', async () => {
    const v = new NullQrVerifier();
    expect(await v.verify([])).toBeNull();
    expect(await v.verify(['anything'])).toBeNull();
  });

  it('QR_VERIFIER is a unique token', () => {
    expect(typeof QR_VERIFIER).toBe('symbol');
  });
});

describe('StatementVerificationService', () => {
  it('an image statement with the null verifier: warning only, qrVerified=null', async () => {
    const svc = new StatementVerificationService(registry(), new NullQrVerifier());
    const r = await svc.verify(golomtParsed(), image);
    expect(r.qrVerified).toBeNull();
    expect(r.issues.find((i) => i.code === 'QR_NOT_VERIFIED')?.severity).toBe('WARNING');
    expect(r.verifierOk).toBe(true);
  });

  it('passes the QR payloads to the verifier and uses its answer', async () => {
    const yes = new Spy(true);
    const ok = await new StatementVerificationService(registry(), yes).verify(golomtParsed(), image);
    expect(yes.calls).toEqual([['SYNTHETIC-QR-1', 'SYNTHETIC-QR-2']]);
    expect(ok.qrVerified).toBe(true);
    expect(ok.issues.map((i) => i.code)).not.toContain('QR_NOT_VERIFIED');

    const no = await new StatementVerificationService(registry(), new Spy(false)).verify(golomtParsed(), image);
    expect(no.qrVerified).toBe(false);
    expect(no.verifierOk).toBe(false);
  });

  it('does not call the verifier for a plain PDF without a QR', async () => {
    const spy = new Spy(true);
    const r = await new StatementVerificationService(registry(), spy).verify(baselineParsed(), PDF_META);
    expect(spy.calls).toEqual([]);
    expect(r.qrVerified).toBeNull();
  });

  it('a verifier that throws is treated as "not verified" and does not break verification', async () => {
    const r = await new StatementVerificationService(registry(), new Spy(new Error('endpoint down'))).verify(golomtParsed(), image);
    expect(r.qrVerified).toBeNull();
    expect(r.issues.map((i) => i.code)).toContain('QR_NOT_VERIFIED');
  });

  it("takes the bank's policy from the registry: Khan does not accept images", async () => {
    const svc = new StatementVerificationService(registry(), new NullQrVerifier());
    const khan = BANK_SPECS.KHAN;
    const parsed = khan.parser.parse(bankStatement(khan, specTransactions(khan)).text);
    const r = await svc.verify(parsed, image);
    expect(r.issues.map((i) => i.code)).toContain('IMAGE_NOT_ACCEPTED');
    expect(r.verifierOk).toBe(false);

    const golomt = BANK_SPECS.GOLOMT;
    const other = golomt.parser.parse(bankStatement(golomt, specTransactions(golomt)).text);
    expect((await svc.verify(other, image)).issues.map((i) => i.code)).not.toContain('IMAGE_NOT_ACCEPTED');
  });

  it('an explicit policy in the options wins over the registry', async () => {
    const svc = new StatementVerificationService(registry(), new NullQrVerifier());
    const khan = BANK_SPECS.KHAN;
    const parsed = khan.parser.parse(bankStatement(khan, specTransactions(khan)).text);
    const r = await svc.verify(parsed, image, { policy: { acceptsImages: true, printsNonStandardIban: false } });
    expect(r.issues.map((i) => i.code)).not.toContain('IMAGE_NOT_ACCEPTED');
  });

  it('customer options reach the verifier', async () => {
    const svc = new StatementVerificationService(registry(), new NullQrVerifier());
    const r = await svc.verify(baselineParsed(), PDF_META, { customer: { names: ['Дорж Сүхбаатар'] } });
    expect(r.issues.map((i) => i.code)).toContain('NAME_MISMATCH');
  });
});
