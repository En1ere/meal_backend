import { Module } from '@nestjs/common';
import { CommunityController, CommunityService } from '../../modules/community/public.js';

@Module({
    imports: [],
    controllers: [CommunityController],
    providers: [CommunityService],
    exports: [],
})
export class CommunityCapabilityModule {}
