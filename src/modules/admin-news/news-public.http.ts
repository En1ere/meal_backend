import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthCookies, UserSessionGuard } from '../auth/auth.http.js';
import { AuthService, type Principal } from '../auth/auth.service.js';
import { newsReadSchema, publicNewsQuerySchema } from './admin-news.contracts.js';
import { NewsPublicService } from './news-public.service.js';

type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
@ApiTags('news')
@Controller('news')
export class NewsPublicController {
    constructor(
        private readonly news: NewsPublicService,
        private readonly auth: AuthService,
        private readonly cookies: AuthCookies,
    ) {}
    private async optional(request: FastifyRequest) {
        const token = request.cookies[this.cookies.name('user')];
        return token ? this.auth.principal(token, 'user') : undefined;
    }
    @Get()
    @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', maxLength: 2000 } })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } })
    async list(
        @Req() request: FastifyRequest,
        @Query() query: unknown,
        @Res({ passthrough: true }) reply: FastifyReply,
    ) {
        reply.header('Cache-Control', 'private, no-store');
        return this.news.list(publicNewsQuerySchema.parse(query), (await this.optional(request))?.id);
    }
    @Get(':id')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    async detail(
        @Req() request: FastifyRequest,
        @Param('id') id: string,
        @Res({ passthrough: true }) reply: FastifyReply,
    ) {
        reply.header('Cache-Control', 'private, no-store');
        return this.news.detail(z.uuid().parse(id), (await this.optional(request))?.id);
    }
    @Post(':id/read')
    @HttpCode(200)
    @ApiCookieAuth('meal_user')
    @UseGuards(UserSessionGuard)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: z.toJSONSchema(newsReadSchema, { io: 'input', target: 'openapi-3.0' }) as Schema })
    read(@Req() request: FastifyRequest & { principal: Principal }, @Param('id') id: string, @Body() body: unknown) {
        const input = newsReadSchema.parse(body);
        return this.news.read(request.principal.id, z.uuid().parse(id), input.idempotencyKey);
    }
}
