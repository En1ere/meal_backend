import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiCreatedResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import {
    chatDraftCommandSchema,
    chatMessageCreateSchema,
    chatMessageHideSchema,
    chatMessageRemoveSchema,
    chatMessageUpdateSchema,
    chatPinCommandSchema,
    chatReactionCommandSchema,
    chatReadCommandSchema,
    familyChatQuerySchema,
} from './family-chat.contracts.js';
import { FamilyChatService } from './family-chat.service.js';

type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as Schema;

@ApiTags('family-chat')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('family/chat')
export class FamilyChatController {
    constructor(private readonly service: FamilyChatService) {}

    @Get()
    @ApiQuery({ name: 'q', required: false, schema: { type: 'string', maxLength: 100, default: '' } })
    @ApiQuery({ name: 'before', required: false, schema: { type: 'string', format: 'date-time' } })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 50, default: 30 } })
    list(@Req() request: Request, @Query() query: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
        reply.header('Cache-Control', 'private, no-store');
        return this.service.list(request.principal.id, familyChatQuerySchema.parse(query));
    }

    @Post('messages')
    @HttpCode(201)
    @ApiCreatedResponse({ description: 'Message created' })
    @ApiBody({ schema: body(chatMessageCreateSchema) })
    send(@Req() request: Request, @Body() input: unknown) {
        return this.service.send(request.principal.id, chatMessageCreateSchema.parse(input));
    }

    @Put('messages/:id')
    @ApiBody({ schema: body(chatMessageUpdateSchema) })
    edit(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.service.edit(request.principal.id, z.uuid().parse(id), chatMessageUpdateSchema.parse(input));
    }

    @Post('messages/:id/remove')
    @HttpCode(200)
    @ApiBody({ schema: body(chatMessageRemoveSchema) })
    remove(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.service.remove(request.principal.id, z.uuid().parse(id), chatMessageRemoveSchema.parse(input));
    }

    @Post('messages/:id/hide')
    @HttpCode(200)
    @ApiBody({ schema: body(chatMessageHideSchema) })
    hide(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.service.hide(request.principal.id, z.uuid().parse(id), chatMessageHideSchema.parse(input));
    }

    @Post('messages/:id/reaction')
    @HttpCode(200)
    @ApiBody({ schema: body(chatReactionCommandSchema) })
    reaction(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.service.reaction(request.principal.id, z.uuid().parse(id), chatReactionCommandSchema.parse(input));
    }

    @Post('messages/:id/pin')
    @HttpCode(200)
    @ApiBody({ schema: body(chatPinCommandSchema) })
    pin(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.service.pin(request.principal.id, z.uuid().parse(id), chatPinCommandSchema.parse(input));
    }

    @Put('draft')
    @ApiBody({ schema: body(chatDraftCommandSchema) })
    draft(@Req() request: Request, @Body() input: unknown) {
        return this.service.draft(request.principal.id, chatDraftCommandSchema.parse(input));
    }

    @Post('read')
    @HttpCode(200)
    @ApiBody({ schema: body(chatReadCommandSchema) })
    read(@Req() request: Request, @Body() input: unknown) {
        return this.service.read(request.principal.id, chatReadCommandSchema.parse(input));
    }
}
