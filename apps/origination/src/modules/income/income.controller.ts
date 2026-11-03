import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { IncomeCalculateBody, IncomeExpensesBody, IncomeFetchNdshBody, IncomeManualInput, IncomeSalaryInput, type RequestContext } from '@los/contracts';
import { Ctx, Roles, ZodValidationPipe } from '@los/nest-common';
import { IncomeService } from './income.service';

// docs/01 §3: унших — ЗЭЗ (өөрийн), салбарын захирал (салбар), батлагч, админ; бичих — ЗЭЗ (өөрийн хүсэлт), админ. Хүрээг ApplicationAccessService шалгана.
const READERS = ['OFFICER', 'BRANCH_MANAGER', 'APPROVER', 'ADMIN'];
const WRITERS = ['OFFICER', 'ADMIN'];
const base = 'applications/:applicationId/income';

@Controller()
export class IncomeController {
  constructor(private readonly income: IncomeService) {}

  @Get(base)
  @Roles(...READERS)
  overview(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string) {
    return this.income.overview(ctx, applicationId);
  }

  @Post(`${base}/ndsh/fetch`)
  @Roles(...WRITERS)
  @HttpCode(200)
  fetchNdsh(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Body(new ZodValidationPipe(IncomeFetchNdshBody)) body: IncomeFetchNdshBody) {
    return this.income.fetchNdsh(ctx, applicationId, body.customerId);
  }

  @Post(`${base}/salaries`)
  @Roles(...WRITERS)
  @HttpCode(201)
  addSalary(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Body(new ZodValidationPipe(IncomeSalaryInput)) body: IncomeSalaryInput) {
    return this.income.addSalary(ctx, applicationId, body);
  }

  @Delete(`${base}/salaries/:salaryId`)
  @Roles(...WRITERS)
  removeSalary(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('salaryId') salaryId: string) {
    return this.income.removeSalary(ctx, applicationId, salaryId);
  }

  @Post(`${base}/calculate`)
  @Roles(...WRITERS)
  @HttpCode(200)
  calculate(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Body(new ZodValidationPipe(IncomeCalculateBody)) body: IncomeCalculateBody) {
    return this.income.calculate(ctx, applicationId, body);
  }

  @Post(`${base}/manual`)
  @Roles(...WRITERS)
  @HttpCode(201)
  addManual(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Body(new ZodValidationPipe(IncomeManualInput)) body: IncomeManualInput) {
    return this.income.addManual(ctx, applicationId, body);
  }

  @Delete(`${base}/manual/:manualId`)
  @Roles(...WRITERS)
  removeManual(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('manualId') manualId: string) {
    return this.income.removeManual(ctx, applicationId, manualId);
  }

  @Put(`${base}/expenses/:customerId`)
  @Roles(...WRITERS)
  setExpenses(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('customerId') customerId: string, @Body(new ZodValidationPipe(IncomeExpensesBody)) body: IncomeExpensesBody) {
    return this.income.setExpenses(ctx, applicationId, customerId, body);
  }

  @Post(`${base}/refresh`)
  @Roles(...WRITERS)
  @HttpCode(200)
  refresh(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string) {
    return this.income.refresh(ctx, applicationId);
  }
}
