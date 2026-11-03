import { Module } from '@nestjs/common';
import { NdshIntegrationModule } from '../../integrations/ndsh/ndsh.module';
import { NdshController } from './ndsh.controller';

@Module({ imports: [NdshIntegrationModule], controllers: [NdshController] })
export class NdshModule {}
