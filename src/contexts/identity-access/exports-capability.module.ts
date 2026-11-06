import { Module } from '@nestjs/common';
import { ExportsController, ExportsService } from '../../modules/exports/public.js';
import { ProAccessCapabilityModule } from '../household-entitlements/pro-access-capability.module.js';
import { CriticalReauthCapabilityModule } from './critical-reauth-capability.module.js';

@Module({
    imports: [CriticalReauthCapabilityModule, ProAccessCapabilityModule],
    controllers: [ExportsController],
    providers: [ExportsService],
    exports: [],
})
export class ExportsCapabilityModule {}
