import { Module } from '@nestjs/common';
import {
    AccountLifecycleController,
    AccountLifecycleService,
    AdminAccountLifecycleController,
} from '../../modules/account-lifecycle/public.js';
import { CriticalReauthCapabilityModule } from './critical-reauth-capability.module.js';

@Module({
    imports: [CriticalReauthCapabilityModule],
    controllers: [AccountLifecycleController, AdminAccountLifecycleController],
    providers: [AccountLifecycleService],
    exports: [],
})
export class AccountLifecycleCapabilityModule {}
