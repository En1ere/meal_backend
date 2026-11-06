import { Module } from '@nestjs/common';
import { AdminAuthController } from '../../modules/admin-auth/public.js';

@Module({
    imports: [],
    controllers: [AdminAuthController],
    providers: [],
    exports: [],
})
export class AdminAuthCapabilityModule {}
