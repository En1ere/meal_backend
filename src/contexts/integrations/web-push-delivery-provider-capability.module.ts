import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../shared/config/app-config.js';
import {
    DisabledWebPushDeliveryProvider,
    VapidWebPushProvider,
    WEB_PUSH_DELIVERY_PROVIDER,
} from '../../modules/delivery-infrastructure/public.js';

@Module({
    imports: [],
    controllers: [],
    providers: [
        DisabledWebPushDeliveryProvider,
        VapidWebPushProvider,
        {
            provide: WEB_PUSH_DELIVERY_PROVIDER,
            inject: [APP_CONFIG, DisabledWebPushDeliveryProvider, VapidWebPushProvider],
            useFactory: (config: AppConfig, disabled: DisabledWebPushDeliveryProvider, vapid: VapidWebPushProvider) =>
                config.WEB_PUSH_ENABLED ? vapid : disabled,
        },
    ],
    exports: [WEB_PUSH_DELIVERY_PROVIDER],
})
export class WebPushDeliveryProviderCapabilityModule {}
