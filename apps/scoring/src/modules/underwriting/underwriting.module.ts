import { Module } from '@nestjs/common';
import { UnderwritingController } from './underwriting.controller';
import { UnderwritingService } from './underwriting.service';

/** Модуль 8 — Тооцоолол (A/B/C). PrismaModule (global), CommonModule (Clock, guard) app түвшинд. Дэлгэрэнгүй: ./README.md */
@Module({ controllers: [UnderwritingController], providers: [UnderwritingService], exports: [UnderwritingService] })
export class UnderwritingModule {}
