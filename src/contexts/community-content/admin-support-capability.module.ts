import { Module } from '@nestjs/common';
import { AdminSupportController, AdminSupportService } from '../../modules/admin-support/public.js';

@Module({
    imports: [],
    controllers: [AdminSupportController],
    providers: [AdminSupportService],
    exports: [],
})
export class AdminSupportCapabilityModule {}
