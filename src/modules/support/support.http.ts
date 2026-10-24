import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { supportCreateSchema, supportEditSchema, supportReplySchema, supportStateSchema } from './support.contracts.js';
import { SupportService } from './support.service.js';
type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const input = (value: z.ZodType) => z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;
@ApiTags('support')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('support')
export class SupportController {
    constructor(private readonly service: SupportService) {}
    @Get('meta') meta() {
        return this.service.meta();
    }
    @Get() list(@Req() req: Request, @Query() query: unknown) {
        return this.service.list(req.principal.id, query);
    }
    @Post() @HttpCode(200) @ApiBody({ schema: input(supportCreateSchema) }) create(
        @Req() req: Request,
        @Body() body: unknown,
    ) {
        return this.service.create(req.principal.id, body);
    }
    @Get(':id') @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } }) detail(
        @Req() req: Request,
        @Param('id') id: string,
    ) {
        return this.service.detail(req.principal.id, id);
    }
    @Post(':id/reply') @HttpCode(200) @ApiBody({ schema: input(supportReplySchema) }) reply(
        @Req() req: Request,
        @Param('id') id: string,
        @Body() body: unknown,
    ) {
        return this.service.reply(req.principal.id, id, body);
    }
    @Patch(':id/messages/:messageId') @HttpCode(200) @ApiBody({ schema: input(supportEditSchema) }) edit(
        @Req() req: Request,
        @Param('id') id: string,
        @Param('messageId') messageId: string,
        @Body() body: unknown,
    ) {
        return this.service.edit(req.principal.id, id, messageId, body);
    }
    @Post(':id/close') @HttpCode(200) @ApiBody({ schema: input(supportStateSchema) }) close(
        @Req() req: Request,
        @Param('id') id: string,
        @Body() body: unknown,
    ) {
        return this.service.state(req.principal.id, id, 'close', body);
    }
    @Post(':id/reopen') @HttpCode(200) @ApiBody({ schema: input(supportStateSchema) }) reopen(
        @Req() req: Request,
        @Param('id') id: string,
        @Body() body: unknown,
    ) {
        return this.service.state(req.principal.id, id, 'reopen', body);
    }
}
