import { Module } from '@nestjs/common';
import { ProOverviewController, ProOverviewService } from '../../modules/pro-overview/public.js';
import { AiCapabilityModule } from '../integrations/ai-capability.module.js';
import { ProAccessCapabilityModule } from './pro-access-capability.module.js';

@Module({
    imports: [AiCapabilityModule, ProAccessCapabilityModule],
    controllers: [ProOverviewController],
    providers: [ProOverviewService],
    exports: [],
})
export class ProOverviewCapabilityModule {}
