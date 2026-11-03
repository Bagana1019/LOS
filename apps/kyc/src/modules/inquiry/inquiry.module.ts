import { Module } from '@nestjs/common';
import { InquiryIntegrationModule } from '../../integrations/inquiry/inquiry-integration.module';
import { InquiryController } from './inquiry.controller';
import { InquiryService } from './inquiry.service';

// Модуль 3 (FR-3): ЗМС, FICO, ӨОХ, мал, ХУР-ын 6 лавлагаа, хар жагсаалтын мөр, бүртгэлгүй зээл. README.md.
@Module({ imports: [InquiryIntegrationModule], controllers: [InquiryController], providers: [InquiryService], exports: [InquiryService] })
export class InquiryModule {}
