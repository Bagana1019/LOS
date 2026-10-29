import { Module } from '@nestjs/common';
import { coreDepositProvider } from '../../integrations/core-deposit/core-deposit.provider';
import { DASHBOARD_CACHE_TTL_MS, DashboardService, dashboardCacheTtlFromEnv } from './dashboard.service';
import { ReportController } from './report.controller';
import { ReportRegistry } from './report-registry';
import { ReportService } from './report.service';

/**
 * Тайлан ба Dashboard (FR-13.3, NFR-1/3/4/9): 9 тайлан (SQL + Excel), KPI dashboard.
 * Депозит дансны үлдэгдэл Core-оос (CoreDepositPort: mock | real=NotImplemented). Дэлгэрэнгүй нь README.md.
 */
@Module({
  controllers: [ReportController],
  providers: [coreDepositProvider, { provide: DASHBOARD_CACHE_TTL_MS, useFactory: () => dashboardCacheTtlFromEnv() }, ReportRegistry, ReportService, DashboardService],
  exports: [ReportService],
})
export class ReportModule {}
