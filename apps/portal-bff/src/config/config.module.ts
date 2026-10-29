import { Global, Module } from '@nestjs/common';
import { PORTAL_CONFIG, loadConfig } from './portal.config';

/** Тохиргоо эхлэх үед нэг удаа шалгагдана (буруу бол процесс эхлэхгүй). Тест `overrideProvider(PORTAL_CONFIG)`-ээр солино. */
@Global()
@Module({
  providers: [{ provide: PORTAL_CONFIG, useFactory: () => loadConfig() }],
  exports: [PORTAL_CONFIG],
})
export class PortalConfigModule {}
