import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import {
    combinationConsentSchema,
    combinationPreviewRequestSchema,
    downgradePreviewRequestSchema,
    planPreviewRequestSchema,
    plusPreviewRequestSchema,
    previewCommitSchema,
    renewalPreviewRequestSchema,
    versionedCommandSchema,
} from './subscription-settings.contracts.js';
import { SubscriptionSettingsService } from './subscription-settings.service.js';

type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as Schema;

@ApiTags('subscription-settings')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('settings/subscription')
export class SubscriptionSettingsController {
    constructor(private readonly service: SubscriptionSettingsService) {}

    @Get()
    get(@Req() request: Request) {
        return this.service.get(request.principal.id);
    }

    @Post('trial/activate')
    @HttpCode(200)
    @ApiBody({ schema: body(versionedCommandSchema) })
    activateTrial(@Req() request: Request, @Body() input: unknown) {
        return this.service.activateTrial(input, request.principal, request.id);
    }

    @Post('plus/preview')
    @HttpCode(200)
    @ApiBody({ schema: body(plusPreviewRequestSchema) })
    previewPlus(@Req() request: Request, @Body() input: unknown) {
        return this.service.previewPlus(input, request.principal);
    }

    @Post('plus/commit')
    @HttpCode(200)
    @ApiBody({ schema: body(previewCommitSchema) })
    commitPlus(@Req() request: Request, @Body() input: unknown) {
        return this.service.commitPlus(input, request.principal, request.id);
    }

    @Post('plan/preview')
    @HttpCode(200)
    @ApiBody({ schema: body(planPreviewRequestSchema) })
    previewPlan(@Req() request: Request, @Body() input: unknown) {
        return this.service.previewPlan(input, request.principal);
    }

    @Post('plan/commit')
    @HttpCode(200)
    @ApiBody({ schema: body(previewCommitSchema) })
    commitPlan(@Req() request: Request, @Body() input: unknown) {
        return this.service.commitPlan(input, request.principal, request.id);
    }

    @Post('renewal/preview')
    @HttpCode(200)
    @ApiBody({ schema: body(renewalPreviewRequestSchema) })
    previewRenewal(@Req() request: Request, @Body() input: unknown) {
        return this.service.previewRenewal(input, request.principal);
    }

    @Post('renewal/commit')
    @HttpCode(200)
    @ApiBody({ schema: body(previewCommitSchema) })
    commitRenewal(@Req() request: Request, @Body() input: unknown) {
        return this.service.commitRenewal(input, request.principal, request.id);
    }

    @Post('combination/preview')
    @HttpCode(200)
    @ApiBody({ schema: body(combinationPreviewRequestSchema) })
    previewCombination(@Req() request: Request, @Body() input: unknown) {
        return this.service.previewCombination(input, request.principal);
    }

    @Post('combination/consent')
    @HttpCode(200)
    @ApiBody({ schema: body(combinationConsentSchema) })
    consentCombination(@Req() request: Request, @Body() input: unknown) {
        return this.service.consentCombination(input, request.principal, request.id);
    }

    @Post('downgrade/preview')
    @HttpCode(200)
    @ApiBody({ schema: body(downgradePreviewRequestSchema) })
    previewDowngrade(@Req() request: Request, @Body() input: unknown) {
        return this.service.previewDowngrade(input, request.principal);
    }

    @Post('downgrade/commit')
    @HttpCode(200)
    @ApiBody({ schema: body(previewCommitSchema) })
    commitDowngrade(@Req() request: Request, @Body() input: unknown) {
        return this.service.commitDowngrade(input, request.principal, request.id);
    }
}
