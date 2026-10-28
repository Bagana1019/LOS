import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { BlacklistAccessGuard, Ctx, Roles, WRITE_ROLES, type RequestContext } from './blacklist.context';
import { BlacklistCreateBody, BlacklistImportJsonBody, BlacklistListQuery, BlacklistPatchBody, MAX_IMPORT_ROWS } from './blacklist.schemas';
import { BlacklistService, importLimitError, type ImportItem } from './blacklist.service';
import { CsvFormatError, CsvRowLimitError, parseBlacklistCsv } from './csv';
import { PathParam, ZodPipe, assertCleanText } from './zod.pipe';

const importJson = new ZodPipe(BlacklistImportJsonBody);

/** FR-13.1: хар жагсаалт CRUD, импорт (BR-9: зөвхөн анхааруулга). Эрх gateway-д шийдэгдэнэ; энд зөвхөн дүрийн шалгалт (CLAUDE.md §3.2.9). */
@Controller('blacklist')
@UseGuards(BlacklistAccessGuard)
export class BlacklistController {
  constructor(@Inject(BlacklistService) private readonly blacklist: BlacklistService) {}

  @Get()
  list(@Query(new ZodPipe(BlacklistListQuery)) q: BlacklistListQuery, @Ctx() ctx: RequestContext) {
    return this.blacklist.list(ctx, q);
  }

  @Get(':id')
  get(@Param('id', PathParam) id: string, @Ctx() ctx: RequestContext) {
    return this.blacklist.get(ctx, id);
  }

  @Post()
  @Roles(...WRITE_ROLES)
  create(@Body(new ZodPipe(BlacklistCreateBody)) body: z.infer<typeof BlacklistCreateBody>, @Ctx() ctx: RequestContext) {
    return this.blacklist.create(ctx, body);
  }

  /** text/csv (csv-body.middleware) эсвэл JSON `{ rows: [...] }`. */
  @Post('import')
  @HttpCode(200)
  @Roles(...WRITE_ROLES)
  import(@Body() body: unknown, @Ctx() ctx: RequestContext) {
    return this.blacklist.importRows(ctx, this.toItems(body));
  }

  @Patch(':id')
  @Roles(...WRITE_ROLES)
  update(@Param('id', PathParam) id: string, @Body(new ZodPipe(BlacklistPatchBody)) body: z.infer<typeof BlacklistPatchBody>, @Ctx() ctx: RequestContext) {
    return this.blacklist.update(ctx, id, body);
  }

  /** Устгахгүй — идэвхгүй болгоно (идэмпотент). */
  @Delete(':id')
  @Roles(...WRITE_ROLES)
  deactivate(@Param('id', PathParam) id: string, @Ctx() ctx: RequestContext) {
    return this.blacklist.deactivate(ctx, id);
  }

  private toItems(body: unknown): ImportItem[] {
    if (typeof body !== 'string') return importJson.transform(body).rows.map((data, i) => ({ row: i + 1, data }));
    // NUL нь Postgres-д хадгалагдахгүй; UTF-16 файл (ASCII тэмдэгт бүр NUL-тай) ихэвчлэн ингэж илрэнэ. U+FFFD-г csv-body.middleware
    // аль хэдийн няцаасан ч (decodeUtf8), энд дахин шалгана: body нь өөр замаар string болж ирсэн ч DB хүртэл орохгүй.
    assertCleanText(body, ' (the file must be UTF-8 text)');
    try {
      // Мөрийн дээд хязгаарыг задлах явцад мөрдөнө: том файл сая сая объект үүсгэхгүй (413).
      return parseBlacklistCsv(body, MAX_IMPORT_ROWS);
    } catch (e) {
      if (e instanceof CsvRowLimitError) throw importLimitError();
      if (e instanceof CsvFormatError) throw new BadRequestException(e.message);
      throw e;
    }
  }
}
