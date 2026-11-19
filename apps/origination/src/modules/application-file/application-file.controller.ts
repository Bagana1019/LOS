import { Controller, Get, Header, Param, StreamableFile } from '@nestjs/common';
import type { RequestContext } from '@los/contracts';
import { Ctx, Permissions } from '@los/nest-common';
import { ApplicationFileService } from './application-file.service';

/** Gateway: `/api/origination/applications/:applicationId/files/:fileId/content`. Эрх = `application:read` + хүсэлтийн хүрээ + файлын холбоос (service). */
@Controller('applications/:applicationId/files')
export class ApplicationFileController {
  constructor(private readonly files: ApplicationFileService) {}

  @Permissions('application:read') @Get(':fileId/content')
  @Header('X-Content-Type-Options', 'nosniff') @Header('Cache-Control', 'no-store')
  async content(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('fileId') fileId: string): Promise<StreamableFile> {
    const file = await this.files.open(ctx, applicationId, fileId);
    return new StreamableFile(file.content, { type: file.mime, length: file.content.length, disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` });
  }
}
