import { Module } from '@nestjs/common';
import { AdminFreeAiController, AdminFreeAiService } from '../../modules/admin-free-ai/public.js';

@Module({
    imports: [],
    controllers: [AdminFreeAiController],
    providers: [AdminFreeAiService],
    exports: [],
})
export class AdminFreeAiCapabilityModule {}
