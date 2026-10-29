import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { XypCitizenRequest, customerTypeOfRegister, type XypCitizen } from '@los/contracts';
import { DomainError, Permissions, ZodValidationPipe } from '@los/nest-common';
import { z } from 'zod';
import { IntegrationNotImplementedError } from '../../integrations/errors';
import { XYP_CLIENT, XypUnavailableError, type XypClient } from '../../integrations/xyp/xyp.client';

/** FR-2.2 · "ХУР-аас татах". Дуудагч: origination (customer модуль). Регистрийг лог-д бичихгүй. */
@Controller('xyp')
export class XypController {
  constructor(@Inject(XYP_CLIENT) private readonly xyp: XypClient) {}

  @Permissions('customer:write')
  @HttpCode(200)
  @Post('citizen')
  async citizen(@Body(new ZodValidationPipe(XypCitizenRequest)) body: z.infer<typeof XypCitizenRequest>): Promise<XypCitizen> {
    if (!customerTypeOfRegister(body.registerNo)) throw new DomainError('INVALID_REGISTER_NO', 'Регистрийн дугаар буруу (иргэн УБ12345678, байгууллага 7 орон)', 400);
    try {
      const citizen = await this.xyp.getCitizen(body.registerNo);
      if (!citizen) throw new DomainError('XYP_NOT_FOUND', 'ХУР-д ийм регистртэй иргэн/байгууллага олдсонгүй', 404);
      return citizen;
    } catch (e) {
      if (e instanceof XypUnavailableError) throw new DomainError('XYP_UNAVAILABLE', 'ХУР түр ажиллахгүй байна. Хэсэг хугацааны дараа дахин оролдох эсвэл гараар бөглөнө үү', 503);
      if (e instanceof IntegrationNotImplementedError) throw new DomainError('INTEGRATION_NOT_IMPLEMENTED', 'ХУР-ын бодит холболт хараахан хийгдээгүй (INTEGRATION_MODE=mock)', 501);
      throw e;
    }
  }
}
