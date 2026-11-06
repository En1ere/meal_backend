import { Module } from '@nestjs/common';
import {
    DisabledEmailDeliveryProvider,
    EMAIL_DELIVERY_PROVIDER,
} from '../../modules/delivery-infrastructure/public.js';

@Module({
    imports: [],
    controllers: [],
    providers: [
        DisabledEmailDeliveryProvider,
        { provide: EMAIL_DELIVERY_PROVIDER, useExisting: DisabledEmailDeliveryProvider },
    ],
    exports: [EMAIL_DELIVERY_PROVIDER],
})
export class EmailDeliveryProviderCapabilityModule {}
