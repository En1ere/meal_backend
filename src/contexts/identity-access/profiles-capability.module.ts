import { Module } from '@nestjs/common';
import { ProfilesController, ProfilesService } from '../../modules/profiles/public.js';
import { LegalConsentsCapabilityModule } from './legal-consents-capability.module.js';

@Module({
    imports: [LegalConsentsCapabilityModule],
    controllers: [ProfilesController],
    providers: [ProfilesService],
    exports: [],
})
export class ProfilesCapabilityModule {}
