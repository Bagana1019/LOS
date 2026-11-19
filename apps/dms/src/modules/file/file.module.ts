import { Module } from '@nestjs/common';
import { FileController } from './file.controller';
import { FileService } from './file.service';
import { MALWARE_SCANNER } from '../../integrations/malware/malware-scanner';
import { createMalwareScanner } from '../../integrations/malware/malware.factory';
import { OBJECT_STORAGE, createStorage } from './storage';

@Module({
  controllers: [FileController],
  providers: [
    FileService,
    { provide: OBJECT_STORAGE, useFactory: async () => { const s = createStorage(); await s.ensureBucket(); return s; } },
    // M10: INTEGRATION_MODE(_MALWARE)=mock|real (ClamAV); production-д mock бол эхлэхгүй
    { provide: MALWARE_SCANNER, useFactory: () => createMalwareScanner() },
  ],
  exports: [FileService, OBJECT_STORAGE, MALWARE_SCANNER],
})
export class FileModule {}
