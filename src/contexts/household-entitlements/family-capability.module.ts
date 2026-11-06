import { Module } from '@nestjs/common';
import { FamilyController, FamilyService } from '../../modules/family/public.js';
import { EntitlementsCapabilityModule } from './entitlements-capability.module.js';

@Module({
    imports: [EntitlementsCapabilityModule],
    controllers: [FamilyController],
    providers: [FamilyService],
    exports: [],
})
export class FamilyCapabilityModule {}
