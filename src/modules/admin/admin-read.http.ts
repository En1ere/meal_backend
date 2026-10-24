import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AdminSessionGuard } from '../admin-auth/admin-auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { adminSearchSchema, adminSectionSchema, adminRelatedSearchSchema } from './admin-read.contracts.js';
import { AdminReadService } from './admin-read.service.js';

type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new BadRequestException();
    return result.data;
}
@ApiTags('admin')
@ApiCookieAuth('meal_admin')
@UseGuards(AdminSessionGuard)
@Controller('admin')
export class AdminReadController {
    constructor(private readonly admin: AdminReadService) {}
    @Post(':section/:id/related/:collection/search')
    @HttpCode(200)
    @ApiParam({ name: 'section', enum: adminSectionSchema.options })
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiParam({ name: 'collection', schema: { type: 'string', pattern: '^[a-z][a-z-]{0,63}$' } })
    @ApiBody({ schema: z.toJSONSchema(adminRelatedSearchSchema, { io: 'input', target: 'openapi-3.0' }) as Schema })
    related(
        @Param('section') section: string,
        @Param('id') id: string,
        @Param('collection') collection: string,
        @Body() body: unknown,
        @Req() req: FastifyRequest & { principal: Principal },
    ) {
        return this.admin.related(
            parse(adminSectionSchema, section),
            parse(z.string().uuid(), id),
            parse(z.string().regex(/^[a-z][a-z-]{0,63}$/), collection),
            parse(adminRelatedSearchSchema, body),
            req.principal,
            req.id,
        );
    }
    @Post(':section/search')
    @HttpCode(200)
    @ApiParam({ name: 'section', enum: adminSectionSchema.options })
    @ApiBody({ schema: z.toJSONSchema(adminSearchSchema, { io: 'input', target: 'openapi-3.0' }) as Schema })
    search(
        @Param('section') section: string,
        @Body() body: unknown,
        @Req() req: FastifyRequest & { principal: Principal },
    ) {
        return this.admin.search(
            parse(adminSectionSchema, section),
            parse(adminSearchSchema, body),
            req.principal,
            req.id,
        );
    }
    @Get(':section/:id')
    @ApiParam({ name: 'section', enum: adminSectionSchema.options })
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    detail(
        @Param('section') section: string,
        @Param('id') id: string,
        @Req() req: FastifyRequest & { principal: Principal },
    ) {
        return this.admin.detail(
            parse(adminSectionSchema, section),
            parse(z.string().uuid(), id),
            req.principal,
            req.id,
        );
    }
}
