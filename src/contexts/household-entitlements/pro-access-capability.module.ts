import { Module } from '@nestjs/common';
import { ProAccessService } from '../../modules/pro-overview/public.js';
import { EntitlementsCapabilityModule } from './entitlements-capability.module.js';

@Module({
    imports: [EntitlementsCapabilityModule],
    controllers: [],
    providers: [ProAccessService],
    exports: [ProAccessService],
})
export class ProAccessCapabilityModule {}
