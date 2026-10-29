import { Module } from '@nestjs/common';
import { ChangeHandlerRegistry } from './change-handler';
import { CHANGE_REQUEST_STORE } from './change-request.store';
import { ExpirySweeper } from './expiry.sweeper';
import { PolicyChangeHandler } from './handlers/policy-change.handler';
import { PrismaChangeRequestStore } from './infra/prisma-change-request.store';
import { MakerCheckerController } from './maker-checker.controller';
import { MakerCheckerService } from './maker-checker.service';

/**
 * Maker-Checker ("4 нүдний зарчим") — docs/05-maker-checker.md.
 * Домэйн модуль: `imports: [MakerCheckerModule]` хийж, constructor-доо `registry.register(handler)` дуудаад
 * `MakerCheckerService.submit()`-аар өөрчлөлтөө илгээнэ.
 */
@Module({
  controllers: [MakerCheckerController],
  providers: [
    { provide: CHANGE_REQUEST_STORE, useClass: PrismaChangeRequestStore },
    ChangeHandlerRegistry,
    MakerCheckerService,
    PolicyChangeHandler,
    ExpirySweeper,
  ],
  exports: [MakerCheckerService, ChangeHandlerRegistry],
})
export class MakerCheckerModule {}
