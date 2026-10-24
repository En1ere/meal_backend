import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { financePriceObservationCreateSchema } from './finance.contracts.js';
import { PricingService } from './pricing.service.js';

type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (value: z.ZodType): Schema => z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;

@ApiTags('finance-pricing')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('finance')
export class PricingController {
    constructor(private readonly pricing: PricingService) {}
    @Get('prices/catalog') catalog(@Req() request: Request) {
        return this.pricing.catalog(request.principal.id);
    }
    @Get('prices') list(@Req() request: Request) {
        return this.pricing.list(request.principal.id);
    }
    @Post('prices')
    @HttpCode(200)
    @ApiBody({ schema: body(financePriceObservationCreateSchema) })
    create(@Req() request: Request, @Body() input: unknown) {
        return this.pricing.create(request.principal.id, financePriceObservationCreateSchema.parse(input));
    }
    @Get('costs/recipes/:id')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiQuery({ name: 'servings', required: false, schema: { type: 'integer', minimum: 1, maximum: 1000 } })
    recipe(@Req() request: Request, @Param('id') id: string, @Query('servings') servings?: string) {
        const count = servings === undefined ? undefined : z.coerce.number().int().min(1).max(1000).parse(servings);
        return this.pricing.recipeCost(request.principal.id, z.uuid().parse(id), count);
    }
    @Get('costs/shopping-lists/:id')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    shopping(@Req() request: Request, @Param('id') id: string) {
        return this.pricing.shoppingCost(request.principal.id, z.uuid().parse(id));
    }
    @Get('costs/meal-plans/:id')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    plan(@Req() request: Request, @Param('id') id: string) {
        return this.pricing.mealPlanCost(request.principal.id, z.uuid().parse(id));
    }
}
