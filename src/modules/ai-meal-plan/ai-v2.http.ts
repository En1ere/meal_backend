import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard, type Principal } from '../auth/public.js';
import { AiV2OrchestratorService } from './ai-v2-orchestrator.service.js';
import { aiV2MealPlanPreviewRequestSchema, aiV2RunRequestSchema } from './ai-meal-plan.contracts.js';

type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (value: z.ZodType) => z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;

@ApiTags('ai')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('ai/v2')
export class AiV2Controller {
    constructor(private readonly orchestrator: AiV2OrchestratorService) {}

    @Post('preview')
    @HttpCode(200)
    @ApiBody({ schema: body(aiV2MealPlanPreviewRequestSchema) })
    preview(@Req() request: Request, @Body() input: unknown) {
        return this.orchestrator.preview(request.principal.id, input);
    }

    @Post('run')
    @HttpCode(200)
    @ApiBody({ schema: body(aiV2RunRequestSchema) })
    run(@Req() request: Request, @Body() input: unknown) {
        return this.orchestrator.run(request.principal.id, input);
    }

    @Get('operations/:id')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    operation(@Req() request: Request, @Param('id') id: string) {
        return this.orchestrator.operation(request.principal.id, id);
    }
}
