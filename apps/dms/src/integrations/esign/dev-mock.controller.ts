// FR-11.4 DEV-only: mock provider-ийн session дээр зээлдэгчийн "апп дээрх үйлдлийг" гараар хийлгэнэ (жишээ нь `MOCK_ESIGN_APPROVE_AFTER_MS` их үед).
// Нэвтрэлтгүй тул integrations.module.ts зөвхөн INTEGRATION_MODE=mock ба NODE_ENV!=production үед л бүртгэнэ.
import { ConflictException, Controller, HttpCode, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { Public } from '@los/nest-common';
import { ESignProviderError } from './esign-provider.port';
import { isMockSigningControl, type MockSigningControl } from './mock-remote-signer';
import { ProviderRegistry } from './provider.registry';

@Public()
@Controller('dev/esign/mock')
export class DevMockEsignController {
  private readonly controls: readonly MockSigningControl[];

  constructor(@Inject(ProviderRegistry) registry: ProviderRegistry) {
    this.controls = registry.list().filter(isMockSigningControl);
  }

  @Post(':providerRef/approve')
  @HttpCode(200)
  approve(@Param('providerRef') providerRef: string): { providerRef: string; action: 'approve' } {
    this.act(providerRef, (control) => control.approveNow(providerRef));
    return { providerRef, action: 'approve' };
  }

  @Post(':providerRef/decline')
  @HttpCode(200)
  decline(@Param('providerRef') providerRef: string): { providerRef: string; action: 'decline' } {
    this.act(providerRef, (control) => control.declineNow(providerRef));
    return { providerRef, action: 'decline' };
  }

  /** Session-ийг эзэмшдэг mock provider дээр үйлдлийг хийнэ; provider-ийн алдааг HTTP статус руу буулгана */
  private act(providerRef: string, action: (control: MockSigningControl) => void): void {
    const control = this.controls.find((c) => c.owns(providerRef));
    if (!control) throw new NotFoundException('unknown mock session');
    try {
      action(control);
    } catch (err) {
      if (err instanceof ESignProviderError) {
        if (err.code === 'UNKNOWN_SESSION') throw new NotFoundException('unknown mock session');
        if (err.code === 'REJECTED') throw new ConflictException(err.message);
      }
      throw err;
    }
  }
}
