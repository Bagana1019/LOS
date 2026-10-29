import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'merchant:roles';
/** Route-д зөвшөөрөгдсөн дүрүүд (X-Roles-той огтлолцох ёстой). Тэмдэглээгүй route хаагдана (fail closed). */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
