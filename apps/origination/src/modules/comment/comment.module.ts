import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module';
import { CommentController } from './comment.controller';
import { CommentService } from './comment.service';

// Модуль 14 · FR-13.4 тайлбар/чат + @mention (MENTION мэдэгдэл).
@Module({ imports: [NotificationModule], controllers: [CommentController], providers: [CommentService] })
export class CommentModule {}
