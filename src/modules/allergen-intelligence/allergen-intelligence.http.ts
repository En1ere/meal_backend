import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AdminSessionGuard } from '../admin-auth/admin-auth.http.js';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import {
    allergenIconMutationSchema,
    allergenIconUploadSchema,
    allergenMappingMutationSchema,
    allergenReportSchema,
} from './allergen-intelligence.contracts.js';
import { AllergenIntelligenceService } from './allergen-intelligence.service.js';
type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const schema = (value: z.ZodType) => z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;

@ApiTags('allergens')
@Controller('allergens')
export class AllergenReportController {
    constructor(private readonly service: AllergenIntelligenceService) {}
    @Post('reports')
    @HttpCode(200)
    @ApiCookieAuth('meal_user')
    @UseGuards(UserSessionGuard)
    @ApiBody({ schema: schema(allergenReportSchema) })
    report(@Req() req: Request, @Body() body: unknown) {
        return this.service.report(req.principal.id, body);
    }
}

@ApiTags('admin-allergens')
@ApiCookieAuth('meal_admin')
@UseGuards(AdminSessionGuard)
@Controller('admin/allergens')
export class AdminAllergensController {
    constructor(private readonly service: AllergenIntelligenceService) {}
    @Get()
    @ApiQuery({ name: 'q', required: false, schema: { type: 'string', maxLength: 100, default: '' } })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
    @ApiQuery({ name: 'offset', required: false, schema: { type: 'integer', minimum: 0, default: 0 } })
    list(
        @Query('q') q: string | undefined,
        @Query('limit') limit: string | undefined,
        @Query('offset') offset: string | undefined,
    ) {
        return this.service.list({ q, limit, offset });
    }
    @Get('subjects')
    @ApiQuery({ name: 'q', required: false, schema: { type: 'string', maxLength: 100, default: '' } })
    @ApiQuery({ name: 'subjectType', required: true, enum: ['ingredient', 'variant', 'product'] })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } })
    subjects(@Query() query: unknown) {
        return this.service.subjects(query);
    }
    @Get(':code') @ApiParam({ name: 'code', schema: { type: 'string', minLength: 1, maxLength: 80 } }) detail(
        @Param('code') code: string,
    ) {
        return this.service.detail(z.string().min(1).max(80).parse(code));
    }
    @Post(':code/mappings') @HttpCode(200) @ApiBody({ schema: schema(allergenMappingMutationSchema) }) mapping(
        @Param('code') code: string,
        @Body() body: unknown,
        @Req() req: Request,
    ) {
        return this.service.mapping(code, body, req.principal, req.id);
    }
    @Put(':code/icon') @HttpCode(200) @ApiBody({ schema: schema(allergenIconMutationSchema) }) icon(
        @Param('code') code: string,
        @Body() body: unknown,
        @Req() req: Request,
    ) {
        return this.service.icon(code, body, req.principal, req.id);
    }
    @Post(':code/icon/upload')
    @HttpCode(200)
    @ApiParam({ name: 'code', schema: { type: 'string', minLength: 1, maxLength: 80 } })
    @ApiBody({ schema: schema(allergenIconUploadSchema) })
    upload(@Param('code') code: string, @Body() body: unknown) {
        z.string().min(1).max(80).parse(code);
        return this.service.upload(body);
    }
}
