import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AdminSessionGuard } from '../admin-auth/admin-auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import {
    preferenceChangeSchema,
    supportReplySchema,
    supportReopenSchema,
    supportMessagesSearchSchema,
} from './admin-actions.contracts.js';
import { AdminActionsService } from './admin-actions.service.js';
type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
function schema(value: z.ZodType) {
    return z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;
}
function parse<T>(type: z.ZodType<T>, input: unknown): T {
    const result = type.safeParse(input);
    if (!result.success) throw new BadRequestException();
    return result.data;
}
@ApiTags('admin-actions')
@ApiCookieAuth('meal_admin')
@UseGuards(AdminSessionGuard)
@Controller('admin')
export class AdminActionsController {
    constructor(private readonly actions: AdminActionsService) {}
    @Get('notification-preferences')
    preferences(@Req() req: Request) {
        return this.actions.preferences(req.principal, req.id);
    }
    @Post('notification-preferences')
    @HttpCode(200)
    @ApiBody({ schema: schema(preferenceChangeSchema) })
    updatePreferences(@Body() body: unknown, @Req() req: Request) {
        return this.actions.preferences(req.principal, req.id, parse(preferenceChangeSchema, body));
    }
    @Post('support/:id/reply')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: schema(supportReplySchema) })
    reply(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
        return this.actions.support(
            parse(z.string().uuid(), id),
            'reply',
            parse(supportReplySchema, body),
            req.principal,
            req.id,
        );
    }
    @Post('support/:id/reopen')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: schema(supportReopenSchema) })
    reopen(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
        return this.actions.support(
            parse(z.string().uuid(), id),
            'reopen',
            parse(supportReopenSchema, body),
            req.principal,
            req.id,
        );
    }
    @Post('support/:id/messages/search')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: schema(supportMessagesSearchSchema) })
    messages(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
        return this.actions.messages(
            parse(z.string().uuid(), id),
            parse(supportMessagesSearchSchema, body),
            req.principal,
            req.id,
        );
    }
}
