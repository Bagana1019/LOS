import { Body, Controller, HttpCode, Inject, Logger, Post } from '@nestjs/common';
import {
  XypAssetsRequest,
  XypCitizenRequest,
  XypOtpRequest,
  XypPropertyRequest,
  customerTypeOfRegister,
  type XypAssetsResponse,
  type XypCitizen,
  type XypOtpResponse,
  type XypPropertyAsset,
} from '@los/contracts';
import { DomainError, Permissions, ZodValidationPipe } from '@los/nest-common';
import { z } from 'zod';
import { IntegrationNotConfiguredError, IntegrationNotImplementedError } from '../../integrations/errors';
import { XYP_CLIENT, XypOtpNotSentError, XypOtpRejectedError, XypUnavailableError, type XypClient } from '../../integrations/xyp/xyp.client';

const log = new Logger('XypController');

/** Регистрийн хэлбэрийг шалгана (иргэн УБ12345678, байгууллага 7 орон). */
function assertRegisterShape(registerNo: string): void {
  if (!customerTypeOfRegister(registerNo)) throw new DomainError('INVALID_REGISTER_NO', 'Регистрийн дугаар буруу (иргэн УБ12345678, байгууллага 7 орон)', 400);
}

/** ХУР-ын клиентийн алдааг HTTP болгоно: унасан → 503 `XYP_UNAVAILABLE`, бодит холболтгүй → 501 `INTEGRATION_NOT_IMPLEMENTED`. */
async function mapXypErrors<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof XypOtpRejectedError) {
      // Диагностик: зөвхөн SOAP faultcode / тоон resultCode (код, регистр, vendor-ийн текст биш).
      log.warn(`XYP did not accept the citizen code (faultCode=${e.faultCode ?? '-'}, resultCode=${e.resultCode ?? '-'})`);
      throw new DomainError('XYP_OTP_INVALID', 'Иргэний код буруу, хугацаа нь дууссан эсвэл ХУР хүлээн авсангүй. Шинэ код авна уу', 422);
    }
    if (e instanceof XypOtpNotSentError) {
      // 1005 / 1006: ХУР код илгээж чадсангүй (иргэний утас нэр дээр нь бүртгэлгүй эсвэл илгээх боломжгүй) — «ХУР унасан» биш, дахин оролдох нь утгагүй.
      log.warn(`XYP could not send the citizen code (resultCode=${e.resultCode ?? '-'})`);
      throw new DomainError('XYP_OTP_NOT_SENT', 'ХУР иргэний бүртгэлтэй утсанд код илгээж чадсангүй (утас нь иргэний нэр дээр бүртгэлгүй эсвэл илгээх боломжгүй). Иргэнд утасны бүртгэлээ шалгуулах эсвэл гараар бөглөнө үү', 422);
    }
    if (e instanceof XypUnavailableError) {
      // ХУР fault-аар хариулсан ч «код буруу» биш (доголдол, token / гарын үсэг): оношлогоонд зөвхөн faultcode / resultCode.
      if (e.faultCode !== undefined || e.resultCode !== undefined) log.warn(`XYP answered with an unclassified fault (faultCode=${e.faultCode ?? '-'}, resultCode=${e.resultCode ?? '-'})`);
      throw new DomainError('XYP_UNAVAILABLE', 'ХУР түр ажиллахгүй байна. Хэсэг хугацааны дараа дахин оролдох эсвэл гараар бөглөнө үү', 503);
    }
    if (e instanceof IntegrationNotImplementedError) throw new DomainError('INTEGRATION_NOT_IMPLEMENTED', 'ХУР-ын бодит холболт хараахан хийгдээгүй (INTEGRATION_MODE=mock)', 501);
    // Тохиргоо дутуу: хэрэглэгчид «гараар бөглөнө» гэсэн ижил замыг (XYP_UNAVAILABLE) үзүүлнэ; env-ийн нэр, нууц гаргахгүй. origination-ийн кодын жагсаалт хаалттай.
    if (e instanceof IntegrationNotConfiguredError) throw new DomainError('XYP_UNAVAILABLE', 'ХУР-ын холболт тохируулагдаагүй байна. Гараар бөглөнө үү (администраторт мэдэгдэнэ үү)', 503);
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

  /**
   * FR-2.2 · иргэний зөвшөөрөл, 1-р алхам: ХУР иргэний БҮРТГЭЛТЭЙ утсанд нэг удаагийн код илгээнэ. Утасны дугаар хүлээн авахгүй (XypOtpRequest strict).
   * Кодыг ХУР хадгална (LOS-д төлөв байхгүй). Дуудагч: origination (регистр тус бүрийн хүсэлтийн хязгаар, аудит тэнд).
   */
  @Permissions('customer:write')
  @HttpCode(200)
  @Post('citizen/otp')
  async citizenOtp(@Body(new ZodValidationPipe(XypOtpRequest)) body: z.infer<typeof XypOtpRequest>): Promise<XypOtpResponse> {
    assertRegisterShape(body.registerNo);
    return mapXypErrors(async () => {
      if (!(await this.xyp.requestCitizenOtp(body.registerNo))) throw new DomainError('XYP_NOT_FOUND', 'ХУР-д ийм регистртэй иргэн/байгууллага олдсонгүй', 404);
      return { sent: true as const, requestedAt: new Date().toISOString() };
    });
  }

  /** FR-2.2 · 2-р алхам: иргэний утсанд ирсэн кодоор иргэний мэдээлэл. Код буруу / хугацаа дууссан → 422 `XYP_OTP_INVALID`. Код лог, хариунд орохгүй. */
  @Permissions('customer:write')
  @HttpCode(200)
  @Post('citizen')
  async citizen(@Body(new ZodValidationPipe(XypCitizenRequest)) body: z.infer<typeof XypCitizenRequest>): Promise<XypCitizen> {
    assertRegisterShape(body.registerNo);
    return mapXypErrors(async () => {
      const citizen = await this.xyp.getCitizen(body.registerNo, body.otp);
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
