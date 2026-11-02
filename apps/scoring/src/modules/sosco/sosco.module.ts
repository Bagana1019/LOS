import { Module } from '@nestjs/common';
import { SoscoController } from './sosco.controller';
import { SoscoModelService } from './sosco-model.service';
import { SoscoService } from './sosco.service';

/** Модуль 8 — дотоод Sosco Score. PrismaModule (global), CommonModule (Clock, guard) app түвшинд. Дэлгэрэнгүй: ./README.md */
@Module({ controllers: [SoscoController], providers: [SoscoService, SoscoModelService], exports: [SoscoService, SoscoModelService] })
export class SoscoModule {}
