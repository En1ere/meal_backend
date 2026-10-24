import { Body, Controller, Get, Headers, HttpCode, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { requireVersion } from '../inventory/inventory.domain.js';
import { nutritionProfileUpdateSchema, nutritionTargetCreateSchema } from './nutrition.contracts.js';
import { NutritionService } from './nutrition.service.js';

type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const schema = (value: z.ZodType): Schema => z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;

@ApiTags('nutrition')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('nutrition')
export class NutritionController {
    constructor(private readonly nutrition: NutritionService) {}

    @Get('settings')
    settings(@Req() request: Request) {
        return this.nutrition.settings(request.principal.id);
    }

    @Put('profile')
    @HttpCode(200)
    @ApiHeader({ name: 'If-Match', required: false, schema: { type: 'string' } })
    @ApiBody({ schema: schema(nutritionProfileUpdateSchema) })
    profile(@Req() request: Request, @Body() body: unknown, @Headers('if-match') version: string | undefined) {
        const input = nutritionProfileUpdateSchema.parse(body);
        if (input.expectedVersion !== null) requireVersion(version, input.expectedVersion);
        return this.nutrition.updateProfile(request.principal.id, input);
    }

    @Post('targets')
    @HttpCode(200)
    @ApiHeader({ name: 'If-Match', required: true, schema: { type: 'string' } })
    @ApiBody({ schema: schema(nutritionTargetCreateSchema) })
    target(@Req() request: Request, @Body() body: unknown, @Headers('if-match') version: string | undefined) {
        const input = nutritionTargetCreateSchema.parse(body);
        requireVersion(version, input.expectedProfileVersion);
        return this.nutrition.createTarget(request.principal.id, input);
    }

    @Get('analytics')
    @ApiQuery({ name: 'from', required: true, schema: { type: 'string', format: 'date' } })
    @ApiQuery({ name: 'to', required: true, schema: { type: 'string', format: 'date' } })
    analytics(@Req() request: Request, @Query() query: unknown) {
        const input = z.strictObject({ from: z.iso.date(), to: z.iso.date() }).parse(query);
        return this.nutrition.analytics(request.principal.id, input.from, input.to);
    }
}
