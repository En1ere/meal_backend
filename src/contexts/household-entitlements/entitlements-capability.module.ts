import { Module } from '@nestjs/common';
import { EntitlementsController, EntitlementsService } from '../../modules/entitlements/public.js';

@Module({
    controllers: [EntitlementsController],
    providers: [EntitlementsService],
    exports: [EntitlementsService],
})
export class EntitlementsCapabilityModule {}
