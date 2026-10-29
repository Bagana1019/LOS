import { Controller, Get, Param, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { RequestContext } from '@los/contracts';
import { Ctx } from '@los/nest-common';
import type { Response } from 'express';
import { FileService, maxFileBytes, type UploadedFile as Upload } from './file.service';

@Controller('files')
export class FileController {
  constructor(private readonly files: FileService) {}

  /** `multipart/form-data`, талбар `file`. Хэмжээ `FILE_MAX_BYTES` (анхдагч 20MB). */
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: maxFileBytes() + 1, files: 1 } }))
  upload(@Ctx() ctx: RequestContext, @UploadedFile() file: Upload | undefined) {
    return this.files.upload(ctx, file);
  }

  @Get(':id') meta(@Ctx() ctx: RequestContext, @Param('id') id: string) { return this.files.meta(ctx, id); }

  @Get(':id/content')
  async content(@Ctx() ctx: RequestContext, @Param('id') id: string, @Res() res: Response) {
    const { row, stream } = await this.files.open(ctx, id);
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Content-Length', String(row.size));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
}
