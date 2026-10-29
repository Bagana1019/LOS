import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { t } from '../../lib/i18n';

type ItemType = 'page' | 'prev' | 'next' | 'jump-prev' | 'jump-next';
const LABEL: Partial<Record<ItemType, string>> = { prev: 'merchant.page.prev', next: 'merchant.page.next', 'jump-prev': 'merchant.page.jumpPrev', 'jump-next': 'merchant.page.jumpNext' };

/**
 * antd Pagination-ы өмнөх/дараах товч зөвхөн дүрс (aria-label="left"/"right", англи) агуулдаг — screen reader-д монгол нэр өгнө.
 * `<Pagination itemRender={paginationItemRender} />` эсвэл Table-ийн `pagination.itemRender`.
 */
export function paginationItemRender(_page: number, type: ItemType, original: ReactNode): ReactNode {
  const key = LABEL[type];
  if (!key || !isValidElement(original)) return original;
  return cloneElement(original as ReactElement<{ 'aria-label'?: string }>, { 'aria-label': t(key) });
}
