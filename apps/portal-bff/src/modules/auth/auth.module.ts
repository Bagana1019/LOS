import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

/** CustomerAuthGuard-ийг AppModule глобал guard болгон бүртгэнэ (дараалал тодорхой байлгах үүднээс). */
@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionService, TokenService],
  exports: [SessionService, TokenService],
})
export class AuthModule {}
