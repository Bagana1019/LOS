import { Global, Module } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock';
import { PORTAL_CONFIG, type PortalConfig } from '../config/portal.config';
import { CONTRACT_FILES } from './contract-files/contract-files.port';
import { MockContractFiles } from './contract-files/mock-contract-files';
import { RealContractFiles } from './contract-files/real-contract-files';
import { CUSTOMER_DIRECTORY } from './customer-directory/customer-directory.port';
import { MockCustomerDirectory } from './customer-directory/mock-customer-directory';
import { RealCustomerDirectory } from './customer-directory/real-customer-directory';
import { InternalHttpClient } from './internal-http.client';
import { LOAN_SERVICING } from './loan-servicing/loan-servicing.port';
import { MockLoanServicing } from './loan-servicing/mock-loan-servicing';
import { RealLoanServicing } from './loan-servicing/real-loan-servicing';
import { MockLedger } from './mock/mock-ledger';
import { MockOtpSender } from './otp-sender/mock-otp-sender';
import { OTP_SENDER } from './otp-sender/otp-sender.port';
import { RealOtpSender } from './otp-sender/real-otp-sender';
import { MockPaymentCollection } from './payment-collection/mock-payment-collection';
import { PAYMENT_COLLECTION } from './payment-collection/payment-collection.port';
import { RealPaymentCollection } from './payment-collection/real-payment-collection';

export const MOCK_LEDGER = Symbol('MOCK_LEDGER');
export const INTERNAL_HTTP = Symbol('INTERNAL_HTTP');

/**
 * CLAUDE.md §3.2-7: гадаад/дотоод интеграци бүр interface + MockXxx + RealXxx; `INTEGRATION_MODE`-оор солино.
 * mock: нэг MockLedger бүх порт-д хуваалцагдана (төлбөр хийвэл үлдэгдэл өөрчлөгдөнө).
 */
@Global()
@Module({
  providers: [
    {
      provide: MOCK_LEDGER,
      inject: [PORTAL_CONFIG, CLOCK],
      useFactory: (cfg: PortalConfig, clock: Clock) =>
        cfg.integrationMode === 'mock' ? new MockLedger(clock, { timezone: cfg.timezone, paymentConfirmMs: cfg.mock.paymentConfirmMs }) : null,
    },
    {
      provide: INTERNAL_HTTP,
      inject: [PORTAL_CONFIG],
      useFactory: (cfg: PortalConfig) =>
        cfg.integrationMode === 'real'
          ? new InternalHttpClient({ baseUrl: cfg.originationUrl, timeoutMs: cfg.internalTimeoutMs, maxStreamBytes: cfg.internalMaxContractBytes })
          : null,
    },
    {
      provide: CUSTOMER_DIRECTORY,
      inject: [MOCK_LEDGER, INTERNAL_HTTP],
      useFactory: (ledger: MockLedger | null, http: InternalHttpClient | null) =>
        ledger ? new MockCustomerDirectory(ledger) : new RealCustomerDirectory(http as InternalHttpClient),
    },
    {
      provide: OTP_SENDER,
      inject: [INTERNAL_HTTP],
      useFactory: (http: InternalHttpClient | null) => (http ? new RealOtpSender(http) : new MockOtpSender()),
    },
    {
      provide: LOAN_SERVICING,
      inject: [MOCK_LEDGER, INTERNAL_HTTP],
      useFactory: (ledger: MockLedger | null, http: InternalHttpClient | null) =>
        ledger ? new MockLoanServicing(ledger) : new RealLoanServicing(http as InternalHttpClient),
    },
    {
      provide: CONTRACT_FILES,
      inject: [MOCK_LEDGER, INTERNAL_HTTP],
      useFactory: (ledger: MockLedger | null, http: InternalHttpClient | null) =>
        ledger ? new MockContractFiles(ledger) : new RealContractFiles(http as InternalHttpClient),
    },
    {
      provide: PAYMENT_COLLECTION,
      inject: [MOCK_LEDGER, INTERNAL_HTTP],
      useFactory: (ledger: MockLedger | null, http: InternalHttpClient | null) =>
        ledger ? new MockPaymentCollection(ledger) : new RealPaymentCollection(http as InternalHttpClient),
    },
  ],
  exports: [MOCK_LEDGER, CUSTOMER_DIRECTORY, OTP_SENDER, LOAN_SERVICING, CONTRACT_FILES, PAYMENT_COLLECTION],
})
export class IntegrationsModule {}
