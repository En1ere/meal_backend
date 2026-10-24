import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { createExportSchema, exportListQuerySchema, exportPreviewRequestSchema } from './exports.contracts.js';
import { ExportsService } from './exports.service.js';

type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as Schema;

@ApiTags('exports')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('exports')
export class ExportsController {
    constructor(private readonly exports: ExportsService) {}

    @Get()
    @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', maxLength: 2000 } })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } })
    list(@Req() request: Request, @Query() query: unknown) {
        return this.exports.list(request.principal.id, exportListQuerySchema.parse(query));
    }

    @Post('preview')
    @HttpCode(200)
    @ApiBody({ schema: body(exportPreviewRequestSchema) })
    preview(@Req() request: Request, @Body() input: unknown) {
        return this.exports.preview(request.principal.id, exportPreviewRequestSchema.parse(input));
    }

    @Post()
    @HttpCode(201)
    @ApiBody({ schema: body(createExportSchema) })
    create(@Req() request: Request, @Body() input: unknown) {
        return this.exports.create(request.principal.id, request.principal.sessionId, createExportSchema.parse(input));
    }

    @Get(':id/download-content')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    download(@Req() request: Request, @Param('id') id: string) {
        return this.exports.download(request.principal.id, z.uuid().parse(id));
    }
}
