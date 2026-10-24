import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminSessionGuard } from '../admin-auth/admin-auth.http.js';
import { supportCreateSchema, supportManageSchema } from './admin-support.contracts.js';
import { AdminSupportService } from './admin-support.service.js';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../auth/auth.service.js';
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const schema = (value: z.ZodType) => z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;
type Request = FastifyRequest & { principal: Principal };
@ApiTags('admin-support')
@ApiCookieAuth('meal_admin')
@UseGuards(AdminSessionGuard)
@Controller('admin/support')
export class AdminSupportController {
    constructor(private readonly service: AdminSupportService) {}
    @Get(':id/workspace')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    workspace(@Param('id') id: string, @Req() request: Request) {
        return this.service.workspace(z.uuid().parse(id), request.principal);
    }
    @Post(':id/manage')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: schema(supportManageSchema) })
    manage(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
        return this.service.manage(z.uuid().parse(id), body, request.principal, request.id);
    }
    @Post('create')
    @HttpCode(200)
    @ApiBody({ schema: schema(supportCreateSchema) })
    create(@Body() body: unknown, @Req() request: Request) {
        return this.service.create(body, request.principal, request.id);
    }
}
