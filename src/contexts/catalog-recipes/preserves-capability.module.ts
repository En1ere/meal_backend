import { Module } from '@nestjs/common';
import { EntitlementsCapabilityModule } from '../household-entitlements/entitlements-capability.module.js';
import { PreservesController, PreservesService } from '../../modules/preserves/public.js';

@Module({
    imports: [EntitlementsCapabilityModule],
    controllers: [PreservesController],
    providers: [PreservesService],
})
export class PreservesCapabilityModule {}
