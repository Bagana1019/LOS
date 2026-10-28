import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule, EventsModule, HealthModule, envFilePaths } from '@los/nest-common';
import { PrismaModule, PrismaService } from './prisma.service';
// Feature модуль бүр: өөрийн мөрийг `import` + `imports` хоёрт задлана (мөр тус бүр тусдаа тул зэрэгцээ салбар мерж хийхэд зөрчилгүй).
// import { ApplicationModule } from './modules/application/application.module';
// import { BorrowerModule } from './modules/borrower/borrower.module';
// import { IncomeModule } from './modules/income/income.module';
import { LoanTermsModule } from './modules/loan-terms/loan-terms.module';
// import { ScheduleModule } from './modules/schedule/schedule.module';
// import { ApprovalModule } from './modules/approval/approval.module';
// import { ContractModule } from './modules/contract/contract.module';
// import { DisbursementModule } from './modules/disbursement/disbursement.module';
// import { BlacklistModule } from './modules/blacklist/blacklist.module';
// import { NotificationModule } from './modules/notification/notification.module';
// import { ReportModule } from './modules/report/report.module';
import { SettingsModule } from './modules/settings/settings.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: envFilePaths }),
    CommonModule.forRoot(),
    PrismaModule,
    EventsModule.forRoot({ schema: 'origination', db: PrismaService }),
    HealthModule.forServiceAsync({ service: 'origination', inject: [PrismaService], useFactory: (db: PrismaService) => ({ db: () => db.$queryRaw`SELECT 1` }) }),
    // ApplicationModule,
    // BorrowerModule,
    // IncomeModule,
    LoanTermsModule,
    // ScheduleModule,
    // ApprovalModule,
    // ContractModule,
    // DisbursementModule,
    // BlacklistModule,
    // NotificationModule,
    // ReportModule,
    SettingsModule,
  ],
})
export class AppModule {}
