import { Module } from '@nestjs/common';
import { AuthController } from '../../modules/auth/public.js';

@Module({
    imports: [],
    controllers: [AuthController],
    providers: [],
    exports: [],
})
export class UserAuthHttpCapabilityModule {}
