import { Module } from '@nestjs/common';
import { MakerCheckerModule } from '../maker-checker/maker-checker.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { ApprovalLevelsChangeHandler } from './approval-levels-change.handler';

@Module({ imports: [MakerCheckerModule], controllers: [AdminController], providers: [AdminService, ApprovalLevelsChangeHandler] })
export class AdminModule {}
