import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { ProOverviewService } from './pro-overview.service.js';

type Request = FastifyRequest & { principal: Principal };

@ApiTags('pro')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('pro')
export class ProOverviewController {
    constructor(private readonly service: ProOverviewService) {}

    @Get('overview')
    get(@Req() request: Request) {
        return this.service.get(request.principal.id);
    }
}
