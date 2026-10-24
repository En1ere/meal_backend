import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { PreservesService } from './preserves.service.js';
import {
    preserveListQuerySchema,
    preserveCreateSchema,
    preserveEditSchema,
    preserveCommandSchema,
    preserveOpenSchema,
    preserveQuantitySchema,
    preserveConsumePreviewInputSchema,
    preserveConsumeSchema,
    preserveHistoryQuerySchema,
    preserveTypeSchema,
    preserveQrIssueSchema,
    preserveScopeInputSchema,
} from './preserves.contracts.js';
type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (value: z.ZodType) => z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;
const id = (value: string) => z.uuid().parse(value);
@ApiTags('preserves')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('preserves')
export class PreservesController {
    constructor(private readonly preserves: PreservesService) {}
    @Get()
    @ApiQuery({ name: 'scope', required: false, enum: ['private', 'family'] })
    @ApiQuery({ name: 'q', required: false, schema: { type: 'string', maxLength: 200 } })
    @ApiQuery({ name: 'type', required: false, enum: preserveTypeSchema.options })
    @ApiQuery({ name: 'locationId', required: false, schema: { type: 'string' } })
    @ApiQuery({ name: 'status', required: false, enum: ['active', 'archived', 'all'] })
    @ApiQuery({ name: 'attention', required: false, enum: ['all', 'expiring', 'expired', 'unknown'] })
    @ApiQuery({ name: 'days', required: false, schema: { type: 'integer', minimum: 1, maximum: 365, default: 14 } })
    @ApiQuery({ name: 'localDate', required: true, schema: { type: 'string', format: 'date' } })
    @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, maximum: 10000, default: 1 } })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } })
    list(@Req() req: Request, @Query() q: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
        reply.header('Cache-Control', 'private, no-store');
        return this.preserves.list(req.principal.id, preserveListQuerySchema.parse(q));
    }
    @Get(':id')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiQuery({ name: 'scope', required: false, enum: ['private', 'family'] })
    detail(
        @Req() req: Request,
        @Param('id') key: string,
        @Query() q: unknown,
        @Res({ passthrough: true }) reply: FastifyReply,
    ) {
        reply.header('Cache-Control', 'private, no-store');
        return this.preserves.detail(req.principal.id, id(key), preserveScopeInputSchema.parse(q).scope);
    }
    @Get(':id/qr-label')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiQuery({ name: 'scope', required: false, enum: ['private', 'family'] })
    qrLabel(
        @Req() req: Request,
        @Param('id') key: string,
        @Query() q: unknown,
        @Res({ passthrough: true }) reply: FastifyReply,
    ) {
        reply.header('Cache-Control', 'private, no-store');
        return this.preserves.qrLabel(req.principal.id, id(key), preserveScopeInputSchema.parse(q).scope);
    }
    @Post(':id/qr-label')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(preserveQrIssueSchema) })
    issueQrLabel(@Req() req: Request, @Param('id') key: string, @Body() input: unknown) {
        return this.preserves.issueQrLabel(req.principal.id, id(key), preserveQrIssueSchema.parse(input));
    }
    @Post()
    @HttpCode(200)
    @ApiBody({ schema: body(preserveCreateSchema) })
    create(@Req() req: Request, @Body() input: unknown) {
        return this.preserves.create(req.principal.id, preserveCreateSchema.parse(input));
    }
    @Post(':id/edit')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(preserveEditSchema) })
    edit(@Req() req: Request, @Param('id') key: string, @Body() input: unknown) {
        return this.preserves.edit(req.principal.id, id(key), preserveEditSchema.parse(input));
    }
    @Post(':id/archive')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(preserveCommandSchema) })
    archive(@Req() req: Request, @Param('id') key: string, @Body() input: unknown) {
        return this.preserves.command(req.principal.id, id(key), 'archive', preserveCommandSchema.parse(input));
    }
    @Post(':id/restore')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(preserveCommandSchema) })
    restore(@Req() req: Request, @Param('id') key: string, @Body() input: unknown) {
        return this.preserves.command(req.principal.id, id(key), 'restore', preserveCommandSchema.parse(input));
    }
    @Post(':id/containers/:containerId/open')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiParam({ name: 'containerId', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(preserveOpenSchema) })
    open(
        @Req() req: Request,
        @Param('id') key: string,
        @Param('containerId') container: string,
        @Body() input: unknown,
    ) {
        return this.preserves.open(req.principal.id, id(key), id(container), preserveOpenSchema.parse(input));
    }
    @Post(':id/containers/:containerId/quantity')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiParam({ name: 'containerId', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(preserveQuantitySchema) })
    quantity(
        @Req() req: Request,
        @Param('id') key: string,
        @Param('containerId') container: string,
        @Body() input: unknown,
    ) {
        return this.preserves.quantity(req.principal.id, id(key), id(container), preserveQuantitySchema.parse(input));
    }
    @Post(':id/consume-preview')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(preserveConsumePreviewInputSchema) })
    preview(
        @Req() req: Request,
        @Param('id') key: string,
        @Body() input: unknown,
        @Res({ passthrough: true }) reply: FastifyReply,
    ) {
        reply.header('Cache-Control', 'private, no-store');
        return this.preserves.consumePreview(req.principal.id, id(key), preserveConsumePreviewInputSchema.parse(input));
    }
    @Post(':id/consume')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(preserveConsumeSchema) })
    consume(@Req() req: Request, @Param('id') key: string, @Body() input: unknown) {
        return this.preserves.consume(req.principal.id, id(key), preserveConsumeSchema.parse(input));
    }
    @Post(':id/recipe-base')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(preserveCommandSchema) })
    recipeBase(@Req() req: Request, @Param('id') key: string, @Body() input: unknown) {
        return this.preserves.recipeBase(req.principal.id, id(key), preserveCommandSchema.parse(input));
    }
    @Get(':id/history')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiQuery({ name: 'scope', required: false, enum: ['private', 'family'] })
    @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, maximum: 10000, default: 1 } })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } })
    history(
        @Req() req: Request,
        @Param('id') key: string,
        @Query() q: unknown,
        @Res({ passthrough: true }) reply: FastifyReply,
    ) {
        reply.header('Cache-Control', 'private, no-store');
        return this.preserves.history(req.principal.id, id(key), preserveHistoryQuerySchema.parse(q));
    }
}
