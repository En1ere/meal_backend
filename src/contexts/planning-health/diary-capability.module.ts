import { Module } from '@nestjs/common';
import { ProAccessCapabilityModule } from '../household-entitlements/pro-access-capability.module.js';
import { LegalConsentsCapabilityModule } from '../identity-access/legal-consents-capability.module.js';
import { DiaryController, DiaryService } from '../../modules/diary/public.js';

@Module({
    imports: [ProAccessCapabilityModule, LegalConsentsCapabilityModule],
    controllers: [DiaryController],
    providers: [DiaryService],
    exports: [DiaryService],
})
export class DiaryCapabilityModule {}
