import { Module } from '@nestjs/common';
import {
    AdminAcceptanceTestsController,
    AdminAcceptanceTestsRepository,
    AdminAcceptanceTestsService,
} from '../../modules/admin-acceptance-tests/public.js';

@Module({
    imports: [],
    controllers: [AdminAcceptanceTestsController],
    providers: [AdminAcceptanceTestsRepository, AdminAcceptanceTestsService],
    exports: [],
})
export class AdminAcceptanceTestsCapabilityModule {}
