import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import {
  XypAssetsRequest,
  XypCitizenRequest,
  XypPropertyRequest,
  customerTypeOfRegister,
  type XypAssetsResponse,
  type XypCitizen,
  type XypPropertyAsset,
} from '@los/contracts';
import { DomainError, Permissions, ZodValidationPipe } from '@los/nest-common';
import { z } from 'zod';
import { IntegrationNotImplementedError } from '../../integrations/errors';
import { XYP_CLIENT, XypUnavailableError, type XypClient } from '../../integrations/xyp/xyp.client';

/** Регистрийн хэлбэрийг шалгана (иргэн УБ12345678, байгууллага 7 орон). */
function assertRegisterShape(registerNo: string): void {
  if (!customerTypeOfRegister(registerNo)) throw new DomainError('INVALID_REGISTER_NO', 'Регистрийн дугаар буруу (иргэн УБ12345678, байгууллага 7 орон)', 400);
}

/** ХУР-ын клиентийн алдааг HTTP болгоно: унасан → 503 `XYP_UNAVAILABLE`, бодит холболтгүй → 501 `INTEGRATION_NOT_IMPLEMENTED`. */
async function mapXypErrors<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof XypUnavailableError) throw new DomainError('XYP_UNAVAILABLE', 'ХУР түр ажиллахгүй байна. Хэсэг хугацааны дараа дахин оролдох эсвэл гараар бөглөнө үү', 503);
    if (e instanceof IntegrationNotImplementedError) throw new DomainError('INTEGRATION_NOT_IMPLEMENTED', 'ХУР-ын бодит холболт хараахан хийгдээгүй (INTEGRATION_MODE=mock)', 501);
    throw e;
  }
}

/**
 * FR-2.2 · "ХУР-аас татах"; FR-6.3 · регистрийн хөрөнгө; FR-6.5 · өмчлөх эрхийн дугаараар өмчлөгчид.
 * Дуудагч: origination. Регистр, өмчлөгчийн нэр, дугаарыг лог-д бичихгүй, хадгалахгүй (CLAUDE.md §6.5).
 */
@Controller('xyp')
export class XypController {
  constructor(@Inject(XYP_CLIENT) private readonly xyp: XypClient) {}

  @Permissions('customer:write')
  @HttpCode(200)
  @Post('citizen')
  async citizen(@Body(new ZodValidationPipe(XypCitizenRequest)) body: z.infer<typeof XypCitizenRequest>): Promise<XypCitizen> {
    assertRegisterShape(body.registerNo);
    return mapXypErrors(async () => {
      const citizen = await this.xyp.getCitizen(body.registerNo);
      if (!citizen) throw new DomainError('XYP_NOT_FOUND', 'ХУР-д ийм регистртэй иргэн/байгууллага олдсонгүй', 404);
      return citizen;
    });
  }

  /** FR-6.3 · регистрийн эзэмшлийн үл хөдлөх хөрөнгө, тээврийн хэрэгсэл. Регистр ХУР-д олдохгүй бол 404 `XYP_NOT_FOUND` (хөрөнгөгүй бол хоосон жагсаалт). */
  @Permissions('customer:read')
  @HttpCode(200)
  @Post('assets')
  async assets(@Body(new ZodValidationPipe(XypAssetsRequest)) body: z.infer<typeof XypAssetsRequest>): Promise<XypAssetsResponse> {
    assertRegisterShape(body.registerNo);
    return mapXypErrors(async () => {
      const assets = await this.xyp.getAssets(body.registerNo);
      if (!assets) throw new DomainError('XYP_NOT_FOUND', 'ХУР-д ийм регистртэй иргэн/байгууллага олдсонгүй', 404);
      return assets;
    });
  }

  /** FR-6.5 · өмчлөх эрхийн дугаараар хөрөнгө ба бүх өмчлөгч. Олдохгүй бол 404 `XYP_NOT_FOUND`. */
  @Permissions('customer:read')
  @HttpCode(200)
  @Post('property')
  async property(@Body(new ZodValidationPipe(XypPropertyRequest)) body: z.infer<typeof XypPropertyRequest>): Promise<XypPropertyAsset> {
    return mapXypErrors(async () => {
      const property = await this.xyp.getProperty(body.propertyId);
      if (!property) throw new DomainError('XYP_NOT_FOUND', 'ХУР-д ийм өмчлөх эрхийн дугаартай үл хөдлөх хөрөнгө олдсонгүй', 404);
      return property;
    });
  }
}
