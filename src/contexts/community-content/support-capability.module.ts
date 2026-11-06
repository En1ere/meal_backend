import { Module } from '@nestjs/common';
import { SupportController, SupportService } from '../../modules/support/public.js';

@Module({
    imports: [],
    controllers: [SupportController],
    providers: [SupportService],
    exports: [],
})
export class SupportCapabilityModule {}
