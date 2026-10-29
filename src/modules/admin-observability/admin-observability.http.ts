import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RouteConfig } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import { AdminSessionGuard } from '../admin-auth/admin-auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { AdminObservabilityService } from './admin-observability.service.js';

@ApiTags('admin-observability')
@ApiCookieAuth('meal_admin')
@UseGuards(AdminSessionGuard)
@Controller('admin/observability')
export class AdminObservabilityController {
    constructor(private readonly observability: AdminObservabilityService) {}

    @Get()
    @RouteConfig({ rateLimit: { max: 12, timeWindow: '1 minute' } })
    @ApiOperation({ summary: 'Bounded production observability snapshot for an unlocked administrator' })
    read(@Req() request: FastifyRequest & { principal: Principal }) {
        return this.observability.read(request.principal, request.id);
    }
}
