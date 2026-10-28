import { Global, Module } from '@nestjs/common';
import { AUTH_CONFIG, loadAuthConfig } from './auth.config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenService } from './token.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [{ provide: AUTH_CONFIG, useFactory: () => loadAuthConfig() }, TokenService, AuthService, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard, AUTH_CONFIG],
})
export class AuthModule {}
