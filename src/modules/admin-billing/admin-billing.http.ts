import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AdminSessionGuard } from '../admin-auth/admin-auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { billingCommandSchema, billingParamsSchema } from './admin-billing.contracts.js';
import { AdminBillingService } from './admin-billing.service.js';
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
type Request = FastifyRequest & { principal: Principal };
@ApiTags('admin-billing')
@ApiCookieAuth('meal_admin')
@UseGuards(AdminSessionGuard)
@Controller('admin/billing')
export class AdminBillingController {
    constructor(private readonly service: AdminBillingService) {}
    @Get(':section/:id')
    @ApiParam({ name: 'section', enum: ['users', 'subscriptions', 'payments'] })
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    view(@Req() request: Request, @Param() raw: unknown) {
        const params = billingParamsSchema.parse(raw);
        return this.service.view(params.section, params.id, request.principal, request.id);
    }
    @Post(':section/:id')
    @HttpCode(200)
    @ApiParam({ name: 'section', enum: ['users', 'subscriptions', 'payments'] })
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: z.toJSONSchema(billingCommandSchema, { io: 'input', target: 'openapi-3.0' }) as Schema })
    command(@Req() request: Request, @Param() raw: unknown, @Body() body: unknown) {
        const params = billingParamsSchema.parse(raw);
        return this.service.command(params.section, params.id, body, request.principal, request.id);
    }
}
