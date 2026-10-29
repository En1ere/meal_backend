import { Body, Controller, Get, Header, HttpCode, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { RouteConfig } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AdminSessionGuard } from '../admin-auth/admin-auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import {
    acceptanceCaseIdSchema,
    acceptanceResetSchema,
    acceptanceUpdateSchema,
} from './admin-acceptance-tests.contracts.js';
import { AdminAcceptanceTestsService } from './admin-acceptance-tests.service.js';

type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const schema = (value: z.ZodType) => z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;

@ApiTags('admin-acceptance-tests')
@ApiCookieAuth('meal_admin')
@UseGuards(AdminSessionGuard)
@Controller('admin/acceptance-tests')
export class AdminAcceptanceTestsController {
    constructor(private readonly service: AdminAcceptanceTestsService) {}

    @Get()
    @Header('Cache-Control', 'no-store')
    @RouteConfig({ rateLimit: { max: 30, timeWindow: '1 minute' } })
    @ApiOperation({ summary: 'Current versioned manual acceptance-test workspace' })
    read(@Req() request: Request) {
        return this.service.read(request.principal);
    }

    @Put(':caseId')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    @ApiParam({ name: 'caseId', schema: { type: 'string', minLength: 3, maxLength: 80 } })
    @ApiBody({ schema: schema(acceptanceUpdateSchema) })
    update(@Param('caseId') caseId: string, @Body() body: unknown, @Req() request: Request) {
        return this.service.update(acceptanceCaseIdSchema.parse(caseId), body, request.principal, request.id);
    }

    @Post(':caseId/reset')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    @ApiParam({ name: 'caseId', schema: { type: 'string', minLength: 3, maxLength: 80 } })
    @ApiBody({ schema: schema(acceptanceResetSchema) })
    reset(@Param('caseId') caseId: string, @Body() body: unknown, @Req() request: Request) {
        return this.service.reset(acceptanceCaseIdSchema.parse(caseId), body, request.principal, request.id);
    }
}
