import { Module } from '@nestjs/common';
import { NotificationCenterController, NotificationCenterService } from '../../modules/admin-notifications/public.js';

@Module({
    imports: [],
    controllers: [NotificationCenterController],
    providers: [NotificationCenterService],
    exports: [],
})
export class AdminNotificationsCapabilityModule {}
