import { Module } from '@nestjs/common';
import { AdminReadController, AdminReadService } from '../../modules/admin/public.js';

@Module({
    imports: [],
    controllers: [AdminReadController],
    providers: [AdminReadService],
    exports: [],
})
export class AdminReadCapabilityModule {}
