import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import {
    planChangeCommitSchema,
    planChangePreviewSchema,
    planQuerySchema,
    planShoppingCommitSchema,
    planShoppingPreviewRequestSchema,
    portionAssignSchema,
    portionDecisionSchema,
    portionScopeQuerySchema,
    planAutomationPreviewSchema,
    planAutomationCommitSchema,
} from './meal-plan.contracts.js';
import { MealPlanService } from './meal-plan.service.js';

type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as Schema;

@ApiTags('meal-plan')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('meal-plan')
export class MealPlanController {
    constructor(private readonly service: MealPlanService) {}

    @Get()
    @ApiQuery({ name: 'scope', required: false, enum: ['private', 'family'] })
    @ApiQuery({ name: 'view', required: false, enum: ['day', 'week', 'range', 'calendar'] })
    @ApiQuery({ name: 'date', required: true, schema: { type: 'string', format: 'date' } })
    @ApiQuery({ name: 'endDate', required: false, schema: { type: 'string', format: 'date' } })
    @ApiQuery({ name: 'timezone', required: true, schema: { type: 'string', minLength: 1, maxLength: 100 } })
    detail(@Req() request: Request, @Query() query: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
        reply.header('Cache-Control', 'private, no-store');
        return this.service.detail(request.principal.id, planQuerySchema.parse(query));
    }

    @Post('change-preview')
    @HttpCode(200)
    @ApiBody({ schema: body(planChangePreviewSchema) })
    preview(@Req() request: Request, @Body() input: unknown) {
        return this.service.preview(request.principal.id, planChangePreviewSchema.parse(input));
    }

    @Post('change-commit')
    @HttpCode(200)
    @ApiBody({ schema: body(planChangeCommitSchema) })
    commit(@Req() request: Request, @Body() input: unknown) {
        return this.service.commit(request.principal.id, planChangeCommitSchema.parse(input));
    }

    @Post('shopping-preview')
    @HttpCode(200)
    @ApiBody({ schema: body(planShoppingPreviewRequestSchema) })
    shoppingPreview(@Req() request: Request, @Body() input: unknown) {
        return this.service.shoppingPreview(request.principal.id, planShoppingPreviewRequestSchema.parse(input));
    }

    @Post('shopping-commit')
    @HttpCode(200)
    @ApiBody({ schema: body(planShoppingCommitSchema) })
    shoppingCommit(@Req() request: Request, @Body() input: unknown) {
        return this.service.shoppingCommit(request.principal.id, planShoppingCommitSchema.parse(input));
    }

    @Post('automation-preview')
    @HttpCode(200)
    @ApiBody({ schema: body(planAutomationPreviewSchema) })
    automationPreview(@Req() request: Request, @Body() input: unknown) {
        return this.service.automationPreview(request.principal.id, planAutomationPreviewSchema.parse(input));
    }

    @Post('automation-commit')
    @HttpCode(200)
    @ApiBody({ schema: body(planAutomationCommitSchema) })
    automationCommit(@Req() request: Request, @Body() input: unknown) {
        return this.service.automationCommit(request.principal.id, planAutomationCommitSchema.parse(input));
    }
}

@ApiTags('portions')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('portions')
export class PortionsController {
    constructor(private readonly service: MealPlanService) {}

    @Get()
    detail(@Req() request: Request, @Query() query: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
        reply.header('Cache-Control', 'private, no-store');
        return this.service.portions(request.principal.id, portionScopeQuerySchema.parse(query));
    }

    @Post('assign')
    @HttpCode(200)
    @ApiBody({ schema: body(portionAssignSchema) })
    assign(@Req() request: Request, @Body() input: unknown) {
        return this.service.assignPortion(request.principal.id, portionAssignSchema.parse(input));
    }

    @Post(':id/decision')
    @HttpCode(200)
    @ApiBody({ schema: body(portionDecisionSchema) })
    decision(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.service.decidePortion(request.principal.id, z.uuid().parse(id), portionDecisionSchema.parse(input));
    }
}
