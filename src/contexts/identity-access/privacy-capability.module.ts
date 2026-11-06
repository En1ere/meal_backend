import { Module } from '@nestjs/common';
import { PrivacyController, PrivacyService } from '../../modules/privacy/public.js';

@Module({
    imports: [],
    controllers: [PrivacyController],
    providers: [PrivacyService],
    exports: [],
})
export class PrivacyCapabilityModule {}
