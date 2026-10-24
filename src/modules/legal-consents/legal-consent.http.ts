import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { consentAcceptSchema, consentRevokeSchema, optionalConsentKindSchema } from './legal-consent.contracts.js';
import { LegalConsentService } from './legal-consent.service.js';
type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const schema = (value: z.ZodType) => z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;
const kind = (value: string) => {
    const parsed = optionalConsentKindSchema.safeParse(value);
    if (!parsed.success) throw new BadRequestException();
    return parsed.data;
};

@ApiTags('legal')
@Controller('legal')
export class PublicLegalController {
    constructor(private readonly service: LegalConsentService) {}
    @Get('manifest') manifest() {
        return this.service.manifest();
    }
}

@ApiTags('legal-consents')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('settings/legal-consents')
export class LegalConsentController {
    constructor(private readonly service: LegalConsentService) {}
    @Get() state(@Req() req: Request) {
        return this.service.state(req.principal.id);
    }
    @Get('history') history(@Req() req: Request) {
        return this.service.history(req.principal.id);
    }
    @Post(':kind/accept')
    @HttpCode(200)
    @ApiBody({ schema: schema(consentAcceptSchema) })
    accept(@Req() req: Request, @Param('kind') rawKind: string, @Body() body: unknown) {
        return this.service.accept(req.principal.id, kind(rawKind), body, req.id);
    }
    @Post(':kind/revoke')
    @HttpCode(200)
    @ApiBody({ schema: schema(consentRevokeSchema) })
    revoke(@Req() req: Request, @Param('kind') rawKind: string, @Body() body: unknown) {
        return this.service.revoke(req.principal.id, kind(rawKind), body, req.id);
    }
}
