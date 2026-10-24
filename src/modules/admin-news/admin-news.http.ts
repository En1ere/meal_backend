import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminSessionGuard } from '../admin-auth/admin-auth.http.js';
import { newsCommandSchema } from './admin-news.contracts.js';
import { AdminNewsService } from './admin-news.service.js';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../auth/auth.service.js';

type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
function schema(index: number) {
    return z.toJSONSchema(newsCommandSchema.options[index]!, { io: 'input', target: 'openapi-3.0' }) as Schema;
}
@ApiTags('admin-news')
@ApiCookieAuth('meal_admin')
@UseGuards(AdminSessionGuard)
@Controller('admin/news-workspace')
export class AdminNewsController {
    constructor(private readonly news: AdminNewsService) {}
    @Get() list() {
        return this.news.list();
    }
    @Post('save')
    @HttpCode(200)
    @ApiBody({ schema: schema(1) })
    save(@Req() request: FastifyRequest & { principal: Principal }, @Body() body: unknown) {
        return this.news.command(request.principal, body);
    }
    @Post('preview')
    @HttpCode(200)
    @ApiBody({ schema: schema(2) })
    preview(@Req() request: FastifyRequest & { principal: Principal }, @Body() body: unknown) {
        return this.news.command(request.principal, body);
    }
    @Post('launch')
    @HttpCode(200)
    @ApiBody({ schema: schema(3) })
    launch(@Req() request: FastifyRequest & { principal: Principal }, @Body() body: unknown) {
        return this.news.command(request.principal, body);
    }
    @Post('cancel')
    @HttpCode(200)
    @ApiBody({ schema: schema(4) })
    cancel(@Req() request: FastifyRequest & { principal: Principal }, @Body() body: unknown) {
        return this.news.command(request.principal, body);
    }
    @Post('test')
    @HttpCode(200)
    @ApiBody({ schema: schema(5) })
    test(@Req() request: FastifyRequest & { principal: Principal }, @Body() body: unknown) {
        return this.news.command(request.principal, body);
    }
}
