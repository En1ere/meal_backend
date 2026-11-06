import { Module } from '@nestjs/common';
import { FamilyNotesController, FamilyNotesService } from '../../modules/family-notes/public.js';
import { EntitlementsCapabilityModule } from './entitlements-capability.module.js';

@Module({
    imports: [EntitlementsCapabilityModule],
    controllers: [FamilyNotesController],
    providers: [FamilyNotesService],
    exports: [],
})
export class FamilyNotesCapabilityModule {}
