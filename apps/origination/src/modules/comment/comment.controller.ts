import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CreateCommentRequest, type RequestContext } from '@los/contracts';
import { Ctx, Roles, ZodValidationPipe } from '@los/nest-common';
import { CommentService } from './comment.service';

const STAFF = ['OFFICER', 'BRANCH_MANAGER', 'APPROVER', 'ADMIN'];

@Controller()
export class CommentController {
  constructor(private readonly comments: CommentService) {}

  @Get('applications/:applicationId/comments')
  @Roles(...STAFF)
  list(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string) {
    return this.comments.list(ctx, applicationId);
  }

  @Post('applications/:applicationId/comments')
  @Roles(...STAFF)
  @HttpCode(201)
  create(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Body(new ZodValidationPipe(CreateCommentRequest)) body: CreateCommentRequest) {
    return this.comments.create(ctx, applicationId, body);
  }
}
