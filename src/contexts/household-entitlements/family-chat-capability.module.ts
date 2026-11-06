import { Module } from '@nestjs/common';
import { FamilyChatController, FamilyChatService } from '../../modules/family-chat/public.js';
import { EntitlementsCapabilityModule } from './entitlements-capability.module.js';

@Module({
    imports: [EntitlementsCapabilityModule],
    controllers: [FamilyChatController],
    providers: [FamilyChatService],
    exports: [],
})
export class FamilyChatCapabilityModule {}
