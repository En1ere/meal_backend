import { Module } from '@nestjs/common';
import { AccountController, MailboxController } from '../../modules/account/public.js';
import { AccountServiceCapabilityModule } from './account-service-capability.module.js';

@Module({
    imports: [AccountServiceCapabilityModule],
    controllers: [AccountController, MailboxController],
    providers: [],
    exports: [],
})
export class AccountHttpCapabilityModule {}
