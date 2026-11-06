import { Module } from '@nestjs/common';
import { AdminGovernanceController, AdminGovernanceService } from '../../modules/admin-governance/public.js';

@Module({
    imports: [],
    controllers: [AdminGovernanceController],
    providers: [AdminGovernanceService],
    exports: [],
})
export class AdminGovernanceCapabilityModule {}
