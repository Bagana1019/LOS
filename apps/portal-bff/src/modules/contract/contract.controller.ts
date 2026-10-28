import { Controller, Get, Param, Res, StreamableFile } from '@nestjs/common';
import { PortalId, type PortalContractInfo } from '@los/contracts';
import type { Response } from 'express';
import type { ServerResponse } from 'node:http';
import type { CallContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { RateLimit } from '../../security/rate-limit.decorator';
import { CallCtx } from '../auth/call-context.decorator';
import { ContractService } from './contract.service';

const loanIdPipe = new ZodPipe(PortalId);

@Controller('portal/loans/:loanId/contract')
export class ContractController {
  constructor(private readonly contracts: ContractService) {}

  @Get()
  info(@CallCtx() ctx: CallContext, @Param('loanId', loanIdPipe) loanId: string): Promise<PortalContractInfo> {
    return this.contracts.info(ctx, loanId);
  }

  /** Гэрээний PDF (гарын үсэгтэй хувилбар байвал түүнийг). */
  @Get('download')
  @RateLimit({ customer: { limit: 20, windowSec: 60 } })
  async download(
    @CallCtx() ctx: CallContext,
    @Param('loanId', loanIdPipe) loanId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { info, stream, contentLength } = await this.contracts.download(ctx, loanId);
    res.on('close', () => {
      stream.destroy(); // Клиент таслахад upstream (origination/dms) холболтыг хаана
      if (!res.writableFinished) void this.contracts.recordAborted(ctx, loanId);
    });
    return new StreamableFile(stream, {
      type: info.mime,
      disposition: contentDisposition(info.fileName, info.contractNo),
      ...(contentLength ? { length: contentLength } : {}),
      // Эхний chunk-ийн дараа алдаа гарвал холболтыг таслана: цэвэр төгсгөл (clean end) нь дутуу PDF-г 200 гэж харагдуулна.
    }).setErrorHandler((err, response) => (response as unknown as ServerResponse).destroy(err));
  }
}

/** RFC 6266: ASCII `filename` + UTF-8 `filename*`. Толгойд аюултай тэмдэгт (CR/LF, ", \, /) оруулахгүй. */
export function contentDisposition(fileName: string, contractNo: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
  const base = safe(fileName.replace(/\.pdf$/i, '')) || `contract-${safe(contractNo)}`;
  const ascii = `${base}.pdf`;
  const utf8 = encodeURIComponent(fileName.replace(/[\r\n"\\/]/g, '_')).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
