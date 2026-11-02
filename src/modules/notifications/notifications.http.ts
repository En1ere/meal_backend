import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import {
    notificationPreferencesUpdateSchema,
    notificationReadAllSchema,
    notificationReadSchema,
    webPushSubscribeSchema,
    webPushUnsubscribeSchema,
} from './notifications.contracts.js';
import { NotificationsService } from './notifications.service.js';
import { WebPushSubscriptionsService } from './web-push-subscriptions.service.js';
type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (value: z.ZodType) => z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;
@ApiTags('notifications')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller()
export class NotificationsController {
    constructor(private readonly service: NotificationsService) {}
    @Get('notifications') list(@Req() req: Request, @Query() query: unknown) {
        return this.service.list(req.principal.id, query);
    }
    @Post('notifications/read-all') @HttpCode(200) @ApiBody({ schema: body(notificationReadAllSchema) }) readAll(
        @Req() req: Request,
        @Body() input: unknown,
    ) {
        return this.service.readAll(req.principal.id, input);
    }
    @Post('notifications/:id/read')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(notificationReadSchema) })
    read(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.service.read(req.principal.id, id, input);
    }
    @Get('notification-preferences') preferences(@Req() req: Request) {
        return this.service.preferences(req.principal.id);
    }
    @Put('notification-preferences')
    @HttpCode(200)
    @ApiBody({ schema: body(notificationPreferencesUpdateSchema) })
    updatePreferences(@Req() req: Request, @Body() input: unknown) {
        return this.service.updatePreferences(req.principal.id, input);
    }
}

@ApiTags('notifications')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller()
export class WebPushSubscriptionsController {
    constructor(private readonly webPush: WebPushSubscriptionsService) {}
    @Get('notification-push/config') pushConfig() {
        return this.webPush.config();
    }
    @Post('notification-push/subscriptions')
    @HttpCode(200)
    @ApiBody({ schema: body(webPushSubscribeSchema) })
    subscribe(@Req() req: Request, @Body() input: unknown) {
        return this.webPush.subscribe(req.principal.id, req.principal.sessionId, input);
    }
    @Delete('notification-push/subscriptions/:id')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(webPushUnsubscribeSchema) })
    unsubscribe(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.webPush.unsubscribe(req.principal.id, req.principal.sessionId, z.uuid().parse(id), input);
    }
}
