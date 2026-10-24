import { Body, Controller, Get, HttpCode, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { onboardingUpdateSchema, preferencesUpdateSchema } from './personalization.contracts.js';
import { PersonalizationService } from './personalization.service.js';
type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as Schema;
@ApiTags('personalization')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller()
export class PersonalizationController {
    constructor(private readonly service: PersonalizationService) {}
    @Get('home') home(@Req() request: Request) {
        return this.service.home(request.principal.id);
    }
    @Get('personalization') detail(@Req() request: Request) {
        return this.service.detail(request.principal.id);
    }
    @Put('personalization/onboarding') @HttpCode(200) @ApiBody({ schema: body(onboardingUpdateSchema) }) onboarding(
        @Req() request: Request,
        @Body() input: unknown,
    ) {
        return this.service.updateOnboarding(request.principal.id, input);
    }
    @Put('personalization/preferences') @HttpCode(200) @ApiBody({ schema: body(preferencesUpdateSchema) }) preferences(
        @Req() request: Request,
        @Body() input: unknown,
    ) {
        return this.service.updatePreferences(request.principal.id, input);
    }
}
