import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { AccountLifecycleService } from './account-lifecycle.service.js';
import {
    adminDeletionDecisionSchema,
    archiveAccountSchema,
    deletionCommandSchema,
    requestDeletionSchema,
} from './account-lifecycle.contracts.js';
import { criticalReauthRequestSchema } from './critical-reauth.contracts.js';
import { CriticalReauthService } from './critical-reauth.service.js';
import { AdminSessionGuard } from '../admin-auth/admin-auth.http.js';

type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as Schema;

@ApiTags('account-lifecycle')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('account')
export class AccountLifecycleController {
    constructor(
        private readonly service: AccountLifecycleService,
        private readonly reauth: CriticalReauthService,
    ) {}
    @Post('critical-reauth')
    @HttpCode(200)
    @ApiBody({ schema: body(criticalReauthRequestSchema) })
    confirm(@Req() request: Request, @Body() raw: unknown) {
        const input = criticalReauthRequestSchema.parse(raw);
        return this.reauth.issue(
            request.principal.id,
            request.principal.sessionId,
            input.password,
            input.factor,
            request.ip,
            request.id,
            input.purpose,
        );
    }
    @Get('lifecycle') state(@Req() request: Request) {
        return this.service.state(request.principal.id);
    }
    @Post('archive')
    @HttpCode(200)
    @ApiBody({ schema: body(archiveAccountSchema) })
    archive(@Req() request: Request, @Body() raw: unknown) {
        const input = archiveAccountSchema.parse(raw);
        return this.service.archive(
            request.principal.id,
            request.principal.sessionId,
            input.reauthToken,
            input.idempotencyKey,
            request.id,
        );
    }
    @Get('deletion/preview') preview(@Req() request: Request) {
        return this.service.preview(request.principal.id);
    }
    @Post('deletion')
    @HttpCode(202)
    @ApiBody({ schema: body(requestDeletionSchema) })
    requestDeletion(@Req() request: Request, @Body() raw: unknown) {
        const input = requestDeletionSchema.parse(raw);
        return this.service.requestDeletion(
            request.principal.id,
            request.principal.sessionId,
            input.reauthToken,
            input.idempotencyKey,
            request.id,
        );
    }
    @Post('deletion/cancel')
    @HttpCode(200)
    @ApiBody({ schema: body(deletionCommandSchema) })
    cancel(@Req() request: Request, @Body() raw: unknown) {
        const input = deletionCommandSchema.parse(raw);
        return this.service.cancelDeletion(
            request.principal.id,
            request.principal.sessionId,
            input.reauthToken,
            input.expectedVersion,
            request.id,
        );
    }
    @Post('deletion/finalize')
    @HttpCode(200)
    @ApiBody({ schema: body(deletionCommandSchema) })
    finalize(@Req() request: Request, @Body() raw: unknown) {
        const input = deletionCommandSchema.parse(raw);
        return this.service.finalizeDeletion(
            request.principal.id,
            request.principal.sessionId,
            input.reauthToken,
            input.expectedVersion,
            request.id,
        );
    }
}

@ApiTags('admin-account-lifecycle')
@ApiCookieAuth('meal_admin')
@UseGuards(AdminSessionGuard)
@Controller('admin/account-deletions')
export class AdminAccountLifecycleController {
    constructor(private readonly service: AccountLifecycleService) {}
    @Post(':id/review')
    @HttpCode(200)
    @ApiBody({ schema: body(adminDeletionDecisionSchema) })
    review(@Req() request: Request, @Param('id') id: string, @Body() raw: unknown) {
        return this.service.reviewDeletion(
            request.principal,
            z.uuid().parse(id),
            adminDeletionDecisionSchema.parse(raw),
            request.id,
        );
    }
}
