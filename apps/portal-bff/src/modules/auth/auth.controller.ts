import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  PortalOtpRequest,
  type PortalOtpChallenge,
  PortalOtpVerify,
  type PortalProfile,
  PortalRefreshRequest,
  type PortalTokens,
} from '@los/contracts';
import type { Request } from 'express';
import { ZodPipe } from '../../common/zod.pipe';
import type { CallContext } from '../../common/request-context';
import { AuthService } from './auth.service';
import { CallCtx, ReqInfo } from './call-context.decorator';
import { Public } from './public.decorator';

@Controller('portal')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Регистр + бүртгэлтэй утас → SMS OTP. Хэрэглэгч байгаа эсэхээс үл хамааран ижил хариу. */
  @Public()
  @Post('auth/otp')
  @HttpCode(200)
  requestOtp(@Body(new ZodPipe(PortalOtpRequest)) body: PortalOtpRequest, @ReqInfo() req: { ip: string; correlationId: string }): Promise<PortalOtpChallenge> {
    return this.auth.requestOtp(body, req);
  }

  @Public()
  @Post('auth/verify')
  @HttpCode(200)
  verify(@Body(new ZodPipe(PortalOtpVerify)) body: PortalOtpVerify, @ReqInfo() req: { ip: string; correlationId: string }): Promise<PortalTokens> {
    return this.auth.verifyOtp(body, req);
  }

  @Public()
  @Post('auth/refresh')
  @HttpCode(200)
  refresh(@Body(new ZodPipe(PortalRefreshRequest)) body: PortalRefreshRequest, @ReqInfo() req: { ip: string; correlationId: string }): Promise<PortalTokens> {
    return this.auth.refresh(body, req);
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(@CallCtx() ctx: CallContext, @Req() req: Request): Promise<void> {
    await this.auth.logout(ctx, (req.principal as NonNullable<Request['principal']>).sessionId);
  }

  @Get('me')
  me(@CallCtx() ctx: CallContext): Promise<PortalProfile> {
    return this.auth.getProfile(ctx);
  }
}
