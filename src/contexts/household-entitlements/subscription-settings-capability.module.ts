import { Module } from '@nestjs/common';
import {
    SubscriptionSettingsController,
    SubscriptionSettingsService,
} from '../../modules/subscription-settings/public.js';
import { EntitlementsCapabilityModule } from './entitlements-capability.module.js';

@Module({
    imports: [EntitlementsCapabilityModule],
    controllers: [SubscriptionSettingsController],
    providers: [SubscriptionSettingsService],
    exports: [],
})
export class SubscriptionSettingsCapabilityModule {}
