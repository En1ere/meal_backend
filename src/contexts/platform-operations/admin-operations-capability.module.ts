import { Module } from '@nestjs/common';
import {
    OperationalMaintenanceService,
    OperationsWorkspaceController,
    OperationsWorkspaceService,
} from '../../modules/admin-operations/public.js';

@Module({
    imports: [],
    controllers: [OperationsWorkspaceController],
    providers: [OperationsWorkspaceService, OperationalMaintenanceService],
    exports: [],
})
export class AdminOperationsCapabilityModule {}
