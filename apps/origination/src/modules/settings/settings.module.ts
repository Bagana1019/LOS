import { Module } from '@nestjs/common';
import { MakerCheckerModule } from '../maker-checker/maker-checker.module';
import { SettingChangeHandler } from './setting-change.handler';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({ imports: [MakerCheckerModule], controllers: [SettingsController], providers: [SettingsService, SettingChangeHandler], exports: [SettingsService] })
export class SettingsModule {}
