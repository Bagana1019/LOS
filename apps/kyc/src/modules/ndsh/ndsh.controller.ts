import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { NdshSalaryRequest, customerTypeOfRegister, type NdshSalaryResponse } from '@los/contracts';
import { Clock, DomainError, Permissions, ZodValidationPipe } from '@los/nest-common';
import { z } from 'zod';
import { IntegrationNotImplementedError } from '../../integrations/errors';
import { NDSH_CLIENT, NdshUnavailableError, type NdshClient } from '../../integrations/ndsh/ndsh.client';

/** FR-4.1 · НДШ-ээс цалин, шимтгэл. Дуудагч: origination (орлогын алхам). Регистр хадгалагдахгүй, лог-д бичигдэхгүй. */
@Controller('ndsh')
export class NdshController {
  constructor(@Inject(NDSH_CLIENT) private readonly ndsh: NdshClient, private readonly clock: Clock) {}

  @Permissions('customer:write')
  @HttpCode(200)
  @Post('salaries')
  async salaries(@Body(new ZodValidationPipe(NdshSalaryRequest)) body: z.infer<typeof NdshSalaryRequest>): Promise<NdshSalaryResponse> {
    if (!customerTypeOfRegister(body.registerNo)) throw new DomainError('INVALID_REGISTER_NO', 'Регистрийн дугаар буруу (иргэн УБ12345678, байгууллага 7 орон)', 400);
    try {
      return { fetchedAt: this.clock.now().toISOString(), items: await this.ndsh.getSalaries(body.registerNo) };
    } catch (e) {
      if (e instanceof NdshUnavailableError) throw new DomainError('NDSH_UNAVAILABLE', 'НДШ түр ажиллахгүй байна. Хэсэг хугацааны дараа дахин оролдох эсвэл цалинг гараар оруулна уу', 503);
      if (e instanceof IntegrationNotImplementedError) throw new DomainError('INTEGRATION_NOT_IMPLEMENTED', 'НДШ-ийн бодит холболт хараахан хийгдээгүй (INTEGRATION_MODE=mock)', 501);
      throw e;
    }
  }
}
