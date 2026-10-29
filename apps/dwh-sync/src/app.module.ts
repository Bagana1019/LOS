import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule, HealthModule, envFilePaths } from '@los/nest-common';
// Feature модуль бүр: өөрийн мөрийг `import` + `imports` хоёрт задлана (мөр тус бүр тусдаа тул зэрэгцээ салбар мерж хийхэд зөрчилгүй).
// import { EtlModule } from './modules/etl/etl.module';
// import { ConsumersModule } from './modules/consumers/consumers.module';

// dwh-sync нь HTTP-ээр өгөгдөл хүлээн авдаггүй (event + CDC) — зөвхөн health. DWH холболтын шалгалтыг ETL модуль нэмнэ.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: envFilePaths }),
    CommonModule.forRoot(),
    HealthModule.forService('dwh-sync'),
    // EtlModule,
    // ConsumersModule,
  ],
})
export class AppModule {}
