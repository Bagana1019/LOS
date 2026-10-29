import type { RequestContext } from '@los/contracts';

export const hasRole = (ctx: Pick<RequestContext, 'roles'>, ...roles: string[]) => roles.some((r) => ctx.roles.includes(r));
