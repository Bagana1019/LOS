import { Module } from '@nestjs/common';
import { DirectoryController } from './directory.controller';
import { DirectoryService } from './directory.service';
import { InternalDirectoryController } from './internal-directory.controller';

@Module({ controllers: [DirectoryController, InternalDirectoryController], providers: [DirectoryService] })
export class DirectoryModule {}
