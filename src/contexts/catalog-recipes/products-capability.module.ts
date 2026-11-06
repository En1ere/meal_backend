import { Module } from '@nestjs/common';
import { ProductsController, ProductsService } from '../../modules/products/public.js';

@Module({
    controllers: [ProductsController],
    providers: [ProductsService],
})
export class ProductsCapabilityModule {}
