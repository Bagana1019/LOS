import { Module } from '@nestjs/common';
import { XypIntegrationModule } from '../../integrations/xyp/xyp.module';
import { XypController } from './xyp.controller';

@Module({ imports: [XypIntegrationModule], controllers: [XypController] })
export class XypModule {}
