import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminSessionGuard } from '../admin-auth/admin-auth.http.js';
import {
    contentModerateSchema,
    contentCompareSchema,
    contentMergeSchema,
    contentNotDuplicateSchema,
} from './admin-content.contracts.js';
import { AdminContentService } from './admin-content.service.js';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../auth/auth.service.js';
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const schema = (value: z.ZodType) => z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;
type Request = FastifyRequest & { principal: Principal };
@ApiTags('admin-content')
@ApiCookieAuth('meal_admin')
@UseGuards(AdminSessionGuard)
@ApiParam({ name: 'section', enum: ['queues', 'catalog'] })
@ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
@Controller('admin/content-workspace/:section/:id')
export class AdminContentController {
    constructor(private readonly service: AdminContentService) {}
    @Get() load(@Param('section') section: string, @Param('id') id: string) {
        return this.service.load({ section, id });
    }
    @Post('moderate') @HttpCode(200) @ApiBody({ schema: schema(contentModerateSchema) }) moderate(
        @Param('section') section: string,
        @Param('id') id: string,
        @Body() body: unknown,
        @Req() request: Request,
    ) {
        return this.service.moderate({ section, id }, body, request.principal, request.id);
    }
    @Post('compare') @HttpCode(200) @ApiBody({ schema: schema(contentCompareSchema) }) compare(
        @Param('section') section: string,
        @Param('id') id: string,
        @Body() body: unknown,
    ) {
        return this.service.compare({ section, id }, body);
    }
    @Post('merge') @HttpCode(200) @ApiBody({ schema: schema(contentMergeSchema) }) merge(
        @Param('section') section: string,
        @Param('id') id: string,
        @Body() body: unknown,
        @Req() request: Request,
    ) {
        return this.service.merge({ section, id }, body, request.principal, request.id);
    }
    @Post('not-duplicate') @HttpCode(200) @ApiBody({ schema: schema(contentNotDuplicateSchema) }) notDuplicate(
        @Param('section') section: string,
        @Param('id') id: string,
        @Body() body: unknown,
        @Req() request: Request,
    ) {
        return this.service.notDuplicate({ section, id }, body, request.principal, request.id);
    }
}
