import { Module } from '@nestjs/common';
import { AdminReadBoundary } from '../../modules/admin-auth/public.js';

@Module({
    imports: [],
    providers: [AdminReadBoundary],
    exports: [AdminReadBoundary],
})
export class AdminReadBoundaryCapabilityModule {}
