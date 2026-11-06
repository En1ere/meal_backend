import { Module } from '@nestjs/common';
import {
    NotificationsController,
    NotificationsService,
    WebPushSubscriptionsController,
    WebPushSubscriptionsService,
} from '../../modules/notifications/public.js';

@Module({
    imports: [],
    controllers: [NotificationsController, WebPushSubscriptionsController],
    providers: [NotificationsService, WebPushSubscriptionsService],
    exports: [],
})
export class NotificationsCapabilityModule {}
