import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminSessionGuard } from '../admin-auth/admin-auth.http.js';
import { operationsCommandSchema } from './operations.contracts.js';
import { OperationsWorkspaceService } from './operations.service.js';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../auth/auth.service.js';
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
@ApiTags('admin-operations')
@ApiCookieAuth('meal_admin')
@UseGuards(AdminSessionGuard)
@Controller('admin/operations-workspace')
export class OperationsWorkspaceController {
    constructor(private readonly service: OperationsWorkspaceService) {}
    @Post('inspect')
    @HttpCode(200)
    @ApiBody({ schema: z.toJSONSchema(operationsCommandSchema, { io: 'input', target: 'openapi-3.0' }) as Schema })
    inspect(@Body() body: unknown) {
        return this.service.inspect(body);
    }
    @Post('preview')
    @HttpCode(200)
    @ApiBody({ schema: z.toJSONSchema(operationsCommandSchema, { io: 'input', target: 'openapi-3.0' }) as Schema })
    preview(@Body() body: unknown) {
        return this.service.preview(body);
    }
    @Post('execute')
    @HttpCode(200)
    @ApiBody({ schema: z.toJSONSchema(operationsCommandSchema, { io: 'input', target: 'openapi-3.0' }) as Schema })
    execute(@Body() body: unknown, @Req() request: FastifyRequest & { principal: Principal }) {
        return this.service.execute(body, request.principal, request.id);
    }
}
