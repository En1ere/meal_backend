import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { AdminSessionGuard } from '../admin-auth/public.js';
import type { Principal } from '../auth/public.js';
import { AdminAiService } from './admin-ai.service.js';

@ApiTags('admin-ai')
@ApiCookieAuth('meal_admin')
@UseGuards(AdminSessionGuard)
@Controller('admin/ai')
export class AdminAiController {
    constructor(private readonly ai: AdminAiService) {}

    @Get()
    @RouteConfig({ rateLimit: { max: 12, timeWindow: '1 minute' } })
    @ApiOperation({ summary: 'Read-only AI provider, policy, entitlement and aggregate usage control plane' })
    read(@Req() request: FastifyRequest & { principal: Principal }) {
        return this.ai.read(request.principal, request.id);
    }
}
