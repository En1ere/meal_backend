import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { CookingService } from './cooking.service.js';
import {
    cookingStartSchema,
    cookingProgressSchema,
    cookingFinalizeSchema,
    cookingListQuerySchema,
    cookingReminderPreferencesChangeSchema,
} from './cooking.contracts.js';
type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as Schema;
@ApiTags('cooking')
@Controller('recipes')
export class CookingStatisticsController {
    constructor(private readonly cooking: CookingService) {}
    @Get(':id/cooking-statistics')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiQuery({ name: 'servings', required: true, schema: { type: 'integer', minimum: 1, maximum: 1000 } })
    statistics(@Param('id') id: string, @Query() input: unknown) {
        const query = z
            .object({ servings: z.coerce.number().int().min(1).max(1000) })
            .strict()
            .parse(input);
        return this.cooking.statistics(z.uuid().parse(id), query.servings);
    }
}
@ApiTags('cooking')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('cooking-attempts')
export class CookingController {
    constructor(private readonly cooking: CookingService) {}
    @Get()
    @ApiQuery({ name: 'view', required: false, enum: ['current', 'archive', 'all'] })
    list(@Req() req: Request, @Res({ passthrough: true }) reply: FastifyReply, @Query() input: unknown) {
        reply.header('Cache-Control', 'private, no-store');
        return this.cooking.list(req.principal.id, cookingListQuerySchema.parse(input));
    }
    @Get('reminder-preferences')
    preferences(@Req() req: Request, @Res({ passthrough: true }) reply: FastifyReply) {
        reply.header('Cache-Control', 'private, no-store');
        return this.cooking.reminderPreferences(req.principal.id);
    }
    @Post('reminder-preferences')
    @HttpCode(200)
    @ApiBody({ schema: body(cookingReminderPreferencesChangeSchema) })
    savePreferences(@Req() req: Request, @Body() input: unknown) {
        return this.cooking.saveReminderPreferences(
            req.principal.id,
            cookingReminderPreferencesChangeSchema.parse(input),
        );
    }
    @Get('stock-options')
    stockOptions(@Req() req: Request, @Res({ passthrough: true }) reply: FastifyReply) {
        reply.header('Cache-Control', 'private, no-store');
        return this.cooking.stockOptions(req.principal.id);
    }
    @Get(':id')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    detail(@Req() req: Request, @Param('id') id: string, @Res({ passthrough: true }) reply: FastifyReply) {
        reply.header('Cache-Control', 'private, no-store');
        return this.cooking.detail(req.principal.id, z.uuid().parse(id));
    }
    @Post()
    @HttpCode(200)
    @ApiBody({ schema: body(cookingStartSchema) })
    start(@Req() req: Request, @Body() input: unknown) {
        return this.cooking.start(req.principal.id, cookingStartSchema.parse(input));
    }
    @Post(':id/progress')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(cookingProgressSchema) })
    progress(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.cooking.progress(req.principal.id, z.uuid().parse(id), cookingProgressSchema.parse(input));
    }
    @Post(':id/finalize')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(cookingFinalizeSchema) })
    finalize(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.cooking.finalize(req.principal.id, z.uuid().parse(id), cookingFinalizeSchema.parse(input));
    }
}
