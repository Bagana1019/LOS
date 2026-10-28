import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';
// import { UnderwritingModule } from './modules/underwriting/underwriting.module';
// import { SoscoModule } from './modules/sosco/sosco.module';
// import { ImportModule } from './modules/bsa/import/import.module';
// import { ClassifyModule } from './modules/bsa/classify/classify.module';
// import { DtiModule } from './modules/bsa/dti/dti.module';
// import { SuspicionModule } from './modules/bsa/suspicion/suspicion.module';
// import { ParsersModule } from './modules/bsa/parsers/parsers.module';
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true })], controllers: [HealthController] })
export class AppModule {}
