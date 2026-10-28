import { Module } from '@nestjs/common';
import { FileController } from './file.controller';
import { FileService } from './file.service';
import { OBJECT_STORAGE, createStorage } from './storage';

@Module({
  controllers: [FileController],
  providers: [FileService, { provide: OBJECT_STORAGE, useFactory: async () => { const s = createStorage(); await s.ensureBucket(); return s; } }],
  exports: [FileService, OBJECT_STORAGE],
})
export class FileModule {}
