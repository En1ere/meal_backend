import { Module } from '@nestjs/common';
import { AccountService } from '../../modules/account/public.js';
import { AccountMailOutboxCapabilityModule } from './account-mail-outbox-capability.module.js';
import { LegalConsentsCapabilityModule } from './legal-consents-capability.module.js';
import { RegistrationRiskCapabilityModule } from './registration-risk-capability.module.js';

@Module({
    imports: [RegistrationRiskCapabilityModule, LegalConsentsCapabilityModule, AccountMailOutboxCapabilityModule],
    controllers: [],
    providers: [AccountService],
    exports: [AccountService],
})
export class AccountServiceCapabilityModule {}
