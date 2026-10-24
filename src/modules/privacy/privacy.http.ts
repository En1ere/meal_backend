import { Body, Controller, Get, HttpCode, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { PrivacyService } from './privacy.service.js';
import { privacyUpdateSchema } from './privacy.contracts.js';
type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
@ApiTags('privacy')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('settings/privacy')
export class PrivacyController {
    constructor(private readonly service: PrivacyService) {}
    @Get() state(@Req() req: Request) {
        return this.service.state(req.principal.id);
    }
    @Put('ai-access')
    @HttpCode(200)
    @ApiBody({ schema: z.toJSONSchema(privacyUpdateSchema, { io: 'input', target: 'openapi-3.0' }) as Schema })
    update(@Req() req: Request, @Body() input: unknown) {
        return this.service.update(req.principal.id, input);
    }
}
