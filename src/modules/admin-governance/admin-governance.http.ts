import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminSessionGuard } from '../admin-auth/admin-auth.http.js';
import { governanceCommandSchema } from './admin-governance.contracts.js';
import { AdminGovernanceService } from './admin-governance.service.js';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../auth/auth.service.js';
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
@ApiTags('admin-governance')
@ApiCookieAuth('meal_admin')
@UseGuards(AdminSessionGuard)
@Controller('admin/governance')
export class AdminGovernanceController {
    constructor(private readonly service: AdminGovernanceService) {}
    @Get(':section/:id')
    @ApiParam({ name: 'section', enum: ['users', 'sanctions', 'access'] })
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    view(@Param('section') section: string, @Param('id') id: string) {
        return this.service.view({ section, id });
    }
    @Post(':section/:id')
    @HttpCode(200)
    @ApiParam({ name: 'section', enum: ['users', 'sanctions', 'access'] })
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: z.toJSONSchema(governanceCommandSchema, { io: 'input', target: 'openapi-3.0' }) as Schema })
    command(
        @Param('section') section: string,
        @Param('id') id: string,
        @Body() body: unknown,
        @Req() request: FastifyRequest & { principal: Principal },
    ) {
        return this.service.command({ section, id }, body, request.principal, request.id);
    }
}
