import { z } from 'zod';

// Модуль 14 · FR-13.4 Хүсэлт бүрт тайлбар/чат, @mention. `mentions` = iam хэрэглэгчийн id (cross-schema FK-гүй).
export const COMMENT_MAX_LENGTH = 2000;
export const COMMENT_MAX_MENTIONS = 20;

export const CreateCommentRequest = z.object({
  body: z.string().trim().min(1).max(COMMENT_MAX_LENGTH),
  mentions: z.array(z.string().trim().min(1).max(64)).max(COMMENT_MAX_MENTIONS).default([]),
});
export type CreateCommentRequest = z.infer<typeof CreateCommentRequest>;

export const CommentView = z.object({
  id: z.string(), applicationId: z.string(), authorId: z.string(), body: z.string(), mentions: z.array(z.string()), createdAt: z.string(),
});
export type CommentView = z.infer<typeof CommentView>;
export const CommentListResponse = z.object({ items: z.array(CommentView) });
export type CommentListResponse = z.infer<typeof CommentListResponse>;
