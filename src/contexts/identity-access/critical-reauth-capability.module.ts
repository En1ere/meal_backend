import { Module } from '@nestjs/common';
import { CriticalReauthService } from '../../modules/account-lifecycle/public.js';

@Module({
    imports: [],
    controllers: [],
    providers: [CriticalReauthService],
    exports: [CriticalReauthService],
})
export class CriticalReauthCapabilityModule {}
