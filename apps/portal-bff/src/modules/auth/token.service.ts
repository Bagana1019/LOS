import { Inject, Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { CLOCK, type Clock } from '../../common/clock';
import { PortalError } from '../../common/portal-error';
import { PORTAL_CONFIG, type PortalConfig } from '../../config/portal.config';

export interface AccessClaims {
  customerId: string;
  sessionId: string;
}

/**
 * Харилцагчийн access JWT (HS256). Ажилтны gateway токентой огт холилдохгүй: тусдаа нууц, issuer, audience.
 * `alg`-ийг зөвхөн HS256 гэж тогтоож (алгоритм сольж давах халдлагаас), хугацааг Clock-оор шалгана.
 */
@Injectable()
export class TokenService {
  constructor(
    @Inject(PORTAL_CONFIG) private readonly cfg: PortalConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  signAccess(claims: AccessClaims): { token: string; expiresInSec: number } {
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    const { accessTtlSec, jwtSecret, issuer, audience } = this.cfg.auth;
    const token = jwt.sign({ sid: claims.sessionId, typ: 'access', iat, exp: iat + accessTtlSec }, jwtSecret, {
      algorithm: 'HS256',
      issuer,
      audience,
      subject: claims.customerId,
      noTimestamp: true,
    });
    return { token, expiresInSec: accessTtlSec };
  }

  verifyAccess(token: string): AccessClaims {
    try {
      const { jwtSecret, issuer, audience } = this.cfg.auth;
      const payload = jwt.verify(token, jwtSecret, {
        algorithms: ['HS256'],
        issuer,
        audience,
        clockTimestamp: Math.floor(this.clock.now().getTime() / 1000),
      });
      if (typeof payload === 'string' || payload.typ !== 'access' || typeof payload.sid !== 'string' || typeof payload.sub !== 'string') {
        throw new Error('bad claims');
      }
      return { customerId: payload.sub, sessionId: payload.sid };
    } catch {
      throw new PortalError('UNAUTHENTICATED');
    }
  }
}
