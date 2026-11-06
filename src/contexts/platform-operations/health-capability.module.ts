import { Module } from '@nestjs/common';
import { HealthController } from '../../modules/health/public.js';

@Module({
    imports: [],
    controllers: [HealthController],
    providers: [],
    exports: [],
})
export class HealthCapabilityModule {}
