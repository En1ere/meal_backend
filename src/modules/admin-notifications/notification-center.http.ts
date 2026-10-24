import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminSessionGuard } from '../admin-auth/admin-auth.http.js';
import { notificationCenterUpdateSchema, notificationReadSchema } from './notification-center.contracts.js';
import { NotificationCenterService } from './notification-center.service.js';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../auth/auth.service.js';
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const schema = (value: z.ZodType) => z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;
type Request = FastifyRequest & { principal: Principal };
@ApiTags('admin-notifications')
@ApiCookieAuth('meal_admin')
@UseGuards(AdminSessionGuard)
@Controller('admin/notification-center')
export class NotificationCenterController {
    constructor(private readonly service: NotificationCenterService) {}
    @Get() read(@Req() request: Request) {
        return this.service.read(request.principal);
    }
    @Post('settings')
    @HttpCode(200)
    @ApiBody({ schema: schema(notificationCenterUpdateSchema) })
    settings(@Body() body: unknown, @Req() request: Request) {
        return this.service.update(body, request.principal, request.id);
    }
    @Post('read')
    @HttpCode(200)
    @ApiBody({ schema: schema(notificationReadSchema) })
    markRead(@Body() body: unknown, @Req() request: Request) {
        return this.service.markRead(body, request.principal, request.id);
    }
}
