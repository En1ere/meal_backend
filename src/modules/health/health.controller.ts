import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DatabaseService } from '../../infrastructure/database/database.service.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
    constructor(private readonly database: DatabaseService) {}
    @Get('live')
    @ApiOperation({ summary: 'Process liveness; does not imply database readiness' })
    @ApiResponse({ status: 200, description: 'Process is serving requests' })
    live() {
        return { status: 'ok' as const };
    }

    @Get('ready')
    @ApiOperation({ summary: 'Database connectivity and non-superuser connection role' })
    @ApiResponse({ status: 200, description: 'Database connection is ready' })
    @ApiResponse({ status: 503, description: 'Database unavailable, unconfigured or unsafe role' })
    async ready() {
        if (!(await this.database.ready())) throw new ServiceUnavailableException();
        return { status: 'ok' as const };
    }
}
