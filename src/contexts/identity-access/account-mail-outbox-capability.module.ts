import { Module } from '@nestjs/common';
import {
    ACCOUNT_MAIL_OUTBOX,
    DisabledAccountMailOutbox,
    PostgresAccountMailOutbox,
} from '../../modules/account/public.js';
import { APP_CONFIG, type AppConfig } from '../../shared/config/app-config.js';

@Module({
    imports: [],
    controllers: [],
    providers: [
        DisabledAccountMailOutbox,
        PostgresAccountMailOutbox,
        {
            provide: ACCOUNT_MAIL_OUTBOX,
            inject: [APP_CONFIG, DisabledAccountMailOutbox, PostgresAccountMailOutbox],
            useFactory: (
                config: AppConfig,
                disabled: DisabledAccountMailOutbox,
                postgres: PostgresAccountMailOutbox,
            ) => (config.ACCOUNT_MAIL_ENABLED ? postgres : disabled),
        },
    ],
    exports: [ACCOUNT_MAIL_OUTBOX],
})
export class AccountMailOutboxCapabilityModule {}
