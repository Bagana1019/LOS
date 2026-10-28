import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';
// import { FileModule } from './modules/file/file.module';
// import { DocumentModule } from './modules/document/document.module';
// import { TemplateModule } from './modules/template/template.module';
// import { RetentionModule } from './modules/retention/retention.module';
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true })], controllers: [HealthController] })
export class AppModule {}
