import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import {
    aiContinueRequestSchema,
    aiHistoryArchiveSchema,
    aiHistoryQuerySchema,
    aiTransferDecisionSchema,
    aiTransferRequestSchema,
    aiPreviewRequestSchema,
    aiPurchaseRequestSchema,
    aiRunRequestSchema,
} from './ai.contracts.js';
import { AiService } from './ai.service.js';
type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (value: z.ZodType) => z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;
@ApiTags('ai')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('ai')
export class AiController {
    constructor(private readonly service: AiService) {}
    @Get('capabilities') capabilities() {
        return this.service.capabilities();
    }
    @Get('balance') balance(@Req() req: Request) {
        return this.service.balance(req.principal.id);
    }
    @Get('history')
    @ApiQuery({ name: 'archived', required: false, enum: ['active', 'archived', 'all'] })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } })
    @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', maxLength: 2000 } })
    history(@Req() req: Request, @Query() query: unknown) {
        return this.service.history(req.principal.id, aiHistoryQuerySchema.parse(query));
    }
    @Put('history/:id/archive')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(aiHistoryArchiveSchema) })
    archiveHistory(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.service.archiveHistory(req.principal.id, id, input);
    }
    @Get('family-sharing') familySharing(@Req() req: Request) {
        return this.service.familySharing(req.principal.id);
    }
    @Post('transfers') @HttpCode(200) @ApiBody({ schema: body(aiTransferRequestSchema) }) requestTransfer(
        @Req() req: Request,
        @Body() input: unknown,
    ) {
        return this.service.requestTransfer(req.principal.id, input);
    }
    @Post('transfers/:id/decision')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(aiTransferDecisionSchema) })
    decideTransfer(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.service.decideTransfer(req.principal.id, id, input);
    }
    @Get('tasks/:id') @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } }) task(
        @Req() req: Request,
        @Param('id') id: string,
    ) {
        return this.service.conversation(req.principal.id, id);
    }
    @Post('preview') @HttpCode(200) @ApiBody({ schema: body(aiPreviewRequestSchema) }) preview(
        @Req() req: Request,
        @Body() input: unknown,
    ) {
        return this.service.preview(req.principal.id, input);
    }
    @Post('run') @HttpCode(200) @ApiBody({ schema: body(aiRunRequestSchema) }) run(
        @Req() req: Request,
        @Body() input: unknown,
    ) {
        return this.service.run(req.principal.id, input);
    }
    @Post('tasks/:id/messages')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(aiContinueRequestSchema) })
    continueTask(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.service.continueTask(req.principal.id, id, input);
    }
    @Post('package/purchase') @HttpCode(200) @ApiBody({ schema: body(aiPurchaseRequestSchema) }) purchase() {
        return this.service.purchase();
    }
}
