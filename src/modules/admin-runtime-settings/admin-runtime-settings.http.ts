import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Principal } from '../auth/auth.service.js';
import { AdminSessionGuard } from '../admin-auth/admin-auth.http.js';
import { webPushPolicyExecuteSchema, webPushPolicyInputSchema } from './admin-runtime-settings.contracts.js';
import { AdminRuntimeSettingsService } from './admin-runtime-settings.service.js';
type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', target: 'openapi-3.0' }) as Schema;
@ApiTags('admin-runtime-settings')
@ApiCookieAuth('meal_admin')
@UseGuards(AdminSessionGuard)
@Controller('admin/runtime-settings')
export class AdminRuntimeSettingsController {
    constructor(private readonly service: AdminRuntimeSettingsService) {}
    @Get() read(@Query('tab') tab: unknown) {
        return this.service.read(tab);
    }
    @Post('web-push-policy/preview') @HttpCode(200) @ApiBody({ schema: body(webPushPolicyInputSchema) }) preview(
        @Req() req: Request,
        @Body() raw: unknown,
    ) {
        return this.service.preview(req.principal, raw);
    }
    @Post('web-push-policy/execute') @HttpCode(200) @ApiBody({ schema: body(webPushPolicyExecuteSchema) }) execute(
        @Req() req: Request,
        @Body() raw: unknown,
    ) {
        return this.service.execute(req.principal, raw);
    }
}
