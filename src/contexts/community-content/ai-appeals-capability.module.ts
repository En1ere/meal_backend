import { Module } from '@nestjs/common';
import { AiAppealsController, AiAppealsService } from '../../modules/ai-appeals/public.js';

@Module({
    imports: [],
    controllers: [AiAppealsController],
    providers: [AiAppealsService],
    exports: [],
})
export class AiAppealsCapabilityModule {}
