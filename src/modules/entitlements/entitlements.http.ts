import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { EntitlementsService } from './entitlements.service.js';

type Request = FastifyRequest & { principal: Principal };

@ApiTags('entitlements')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('entitlements')
export class EntitlementsController {
    constructor(private readonly service: EntitlementsService) {}

    @Get()
    get(@Req() request: Request) {
        return this.service.resolve(request.principal.id);
    }
}
