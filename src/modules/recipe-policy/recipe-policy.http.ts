import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import { AdminSessionGuard } from '../admin-auth/admin-auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { recipePolicyChangeSchema } from './recipe-policy.contracts.js';
import { RecipePolicyService } from './recipe-policy.service.js';
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
@ApiTags('recipe-policy')
@Controller()
export class RecipePolicyController {
    constructor(private readonly policy: RecipePolicyService) {}
    @Get('recipe-policy')
    @ApiCookieAuth('meal_user')
    @UseGuards(UserSessionGuard)
    read() {
        return this.policy.read();
    }
    @Get('admin/settings/recipe-policy')
    @ApiCookieAuth('meal_admin')
    @UseGuards(AdminSessionGuard)
    adminRead() {
        return this.policy.read();
    }
    @Put('admin/settings/recipe-policy')
    @ApiCookieAuth('meal_admin')
    @UseGuards(AdminSessionGuard)
    @ApiBody({ schema: z.toJSONSchema(recipePolicyChangeSchema, { io: 'input', target: 'openapi-3.0' }) as Schema })
    update(@Req() req: FastifyRequest & { principal: Principal }, @Body() body: unknown) {
        return this.policy.update(req.principal, recipePolicyChangeSchema.parse(body), req.id);
    }
}
