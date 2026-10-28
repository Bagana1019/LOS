import { Module } from '@nestjs/common';
import { BlacklistController } from './blacklist.controller';
import { BlacklistLookupService } from './blacklist-lookup.service';

@Module({ controllers: [BlacklistController], providers: [BlacklistLookupService], exports: [BlacklistLookupService] })
export class BlacklistModule {}
