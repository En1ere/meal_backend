import { Module } from '@nestjs/common';
import { AdminReviewController, AdminReviewService, AdminRollbackRegistry } from '../../modules/admin-review/public.js';
import { ContentReleasesCapabilityModule } from './content-releases-capability.module.js';

@Module({
    imports: [ContentReleasesCapabilityModule],
    controllers: [AdminReviewController],
    providers: [AdminRollbackRegistry, AdminReviewService],
    exports: [],
})
export class AdminReviewCapabilityModule {}
