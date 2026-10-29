import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'portal:is-public';

/** Нэвтрэлт шаардахгүй маршрут. Анхдагч нь бүх маршрут хаалттай (fail closed). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
