import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';
// import { InquiryModule } from './modules/inquiry/inquiry.module';
// import { XypModule } from './modules/xyp/xyp.module';
// import { DanModule } from './modules/dan/dan.module';
// import { CibModule } from './modules/cib/cib.module';
// import { NdshModule } from './modules/ndsh/ndsh.module';
// import { AmlModule } from './modules/aml/aml.module';
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true })], controllers: [HealthController] })
export class AppModule {}
