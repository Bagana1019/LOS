import { Module } from '@nestjs/common';
import { MakerCheckerModule } from '../maker-checker/maker-checker.module';
import { ProductController } from './product.controller';
import { ProductCreateHandler, ProductSetActiveHandler, ProductUpdateHandler } from './product-change.handler';
import { ProductService } from './product.service';

@Module({ imports: [MakerCheckerModule], controllers: [ProductController], providers: [ProductService, ProductCreateHandler, ProductUpdateHandler, ProductSetActiveHandler] })
export class ProductModule {}
