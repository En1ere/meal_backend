import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { aiAppealCreateSchema } from './ai-appeals.contracts.js';
import { AiAppealsService } from './ai-appeals.service.js';

type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];

@ApiTags('ai-appeals')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('ai/appeals')
export class AiAppealsController {
    constructor(private readonly appeals: AiAppealsService) {}

    @Get()
    list(@Req() request: Request) {
        return this.appeals.list(request.principal.id);
    }

    @Post()
    @HttpCode(200)
    @ApiBody({ schema: z.toJSONSchema(aiAppealCreateSchema, { io: 'input', target: 'openapi-3.0' }) as Schema })
    create(@Req() request: Request, @Body() input: unknown) {
        return this.appeals.create(request.principal.id, input);
    }

    @Get(':id')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    detail(@Req() request: Request, @Param('id') id: string) {
        return this.appeals.detail(request.principal.id, z.uuid().parse(id));
    }
}
