import { Controller, Get, Post, Param, Query, Body, Req, Res, UseGuards, HttpCode } from '@nestjs/common';
import { ApiTags, ApiCookieAuth, ApiBody, ApiParam, ApiQuery } from '@nestjs/swagger';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AuthCookies, UserSessionGuard } from '../auth/auth.http.js';
import { AuthService, type Principal } from '../auth/auth.service.js';
import { RecipesService } from './recipes.service.js';
import { recipesQuerySchema, recipePersonalQuerySchema, recipeBookmarkSchema } from './recipes.contracts.js';
type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
@ApiTags('recipes')
@Controller('recipes')
export class RecipesController {
    constructor(
        private readonly recipes: RecipesService,
        private readonly auth: AuthService,
        private readonly cookies: AuthCookies,
    ) {}
    @ApiQuery({ name: 'q', required: false, schema: { type: 'string', maxLength: 200 } })
    @ApiQuery({ name: 'category', required: false, schema: { type: 'string', maxLength: 100 } })
    @ApiQuery({ name: 'tab', required: false, enum: ['for-you', 'inventory', 'new'] })
    @ApiQuery({ name: 'scope', required: false, enum: ['private', 'family'] })
    @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, maximum: 10000, default: 1 } })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } })
    @Get()
    async list(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Query() query: unknown) {
        const q = recipesQuerySchema.parse(query);
        const token = req.cookies[this.cookies.name('user')];
        const principal = token || q.tab === 'inventory' ? await this.auth.principal(token, 'user') : undefined;
        reply.header('Cache-Control', 'private, no-store');
        return this.recipes.list(q, principal?.id);
    }
    @Get(':id')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    detail(@Param('id') id: string) {
        return this.recipes.detail(z.uuid().parse(id));
    }
    @ApiQuery({ name: 'servings', required: false, schema: { type: 'integer', minimum: 1, maximum: 1000, default: 1 } })
    @Get(':id/personal')
    @ApiCookieAuth('meal_user')
    @UseGuards(UserSessionGuard)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    personal(
        @Req() req: Request,
        @Param('id') id: string,
        @Query() query: unknown,
        @Res({ passthrough: true }) reply: FastifyReply,
    ) {
        reply.header('Cache-Control', 'private, no-store');
        return this.recipes.personal(
            req.principal.id,
            z.uuid().parse(id),
            recipePersonalQuerySchema.parse(query).servings,
        );
    }
    @Post(':id/bookmark')
    @HttpCode(200)
    @ApiCookieAuth('meal_user')
    @UseGuards(UserSessionGuard)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: z.toJSONSchema(recipeBookmarkSchema, { io: 'input', target: 'openapi-3.0' }) as Schema })
    bookmark(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
        return this.recipes.bookmark(req.principal.id, z.uuid().parse(id), recipeBookmarkSchema.parse(body));
    }
}
