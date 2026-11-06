import { Module } from '@nestjs/common';
import { AdminActionsController, AdminActionsService } from '../../modules/admin-actions/public.js';

@Module({
    imports: [],
    controllers: [AdminActionsController],
    providers: [AdminActionsService],
    exports: [],
})
export class AdminActionsCapabilityModule {}
