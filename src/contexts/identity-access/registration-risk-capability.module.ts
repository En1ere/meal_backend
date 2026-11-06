import { Module } from '@nestjs/common';
import { RegistrationRiskPolicy, registrationRiskConfig } from '../../modules/account/public.js';
import { APP_CONFIG, type AppConfig } from '../../shared/config/app-config.js';

@Module({
    imports: [],
    controllers: [],
    providers: [
        {
            provide: RegistrationRiskPolicy,
            inject: [APP_CONFIG],
            useFactory: (config: AppConfig) => new RegistrationRiskPolicy(registrationRiskConfig(config), null),
        },
    ],
    exports: [RegistrationRiskPolicy],
})
export class RegistrationRiskCapabilityModule {}
