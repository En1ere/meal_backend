import { Module } from '@nestjs/common';
import { StaffAuthController } from '../../modules/auth/public.js';

@Module({
    imports: [],
    controllers: [StaffAuthController],
    providers: [],
    exports: [],
})
export class StaffAuthHttpCapabilityModule {}
