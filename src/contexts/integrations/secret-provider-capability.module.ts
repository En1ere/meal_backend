import { Module } from '@nestjs/common';
import { DisabledSecretProvider, SECRET_PROVIDER } from '../../modules/provider-runtime/public.js';

@Module({
    imports: [],
    controllers: [],
    providers: [DisabledSecretProvider, { provide: SECRET_PROVIDER, useExisting: DisabledSecretProvider }],
    exports: [],
})
export class SecretProviderCapabilityModule {}
