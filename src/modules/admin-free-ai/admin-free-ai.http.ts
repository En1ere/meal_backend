import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AdminSessionGuard } from '../admin-auth/admin-auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { adminFreeAiGrantSchema } from './admin-free-ai.contracts.js';
import { AdminFreeAiService } from './admin-free-ai.service.js';

type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const parseId = (value: string) => {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw new BadRequestException();
    return parsed.data;
};

@ApiTags('admin-free-ai')
@ApiCookieAuth('meal_admin')
@UseGuards(AdminSessionGuard)
@Controller('admin/free-ai/users')
export class AdminFreeAiController {
    constructor(private readonly service: AdminFreeAiService) {}

    @Get(':id')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    view(@Param('id') id: string) {
        return this.service.view(parseId(id));
    }

    @Post(':id/grants')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: z.toJSONSchema(adminFreeAiGrantSchema, { io: 'input', target: 'openapi-3.0' }) as Schema })
    grant(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
        return this.service.grant(parseId(id), body, req.principal, req.id);
    }
}
