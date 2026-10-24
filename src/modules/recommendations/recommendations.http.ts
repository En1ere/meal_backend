import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import {
    authorFollowSchema,
    authorFollowingQuerySchema,
    recommendationEventSchema,
    recommendationsQuerySchema,
} from './recommendations.contracts.js';
import { RecommendationsService } from './recommendations.service.js';

type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as Schema;
type Request = FastifyRequest & { principal: Principal };

@ApiTags('recommendations')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller()
export class RecommendationsController {
    constructor(private readonly recommendations: RecommendationsService) {}

    @Get('recommendations')
    @ApiQuery({ name: 'type', required: false, enum: ['recipe', 'author'] })
    @ApiQuery({ name: 'scope', required: false, enum: ['private', 'family'] })
    @ApiQuery({ name: 'surface', required: false, enum: ['home', 'recipes', 'authors'] })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 50 } })
    list(@Req() request: Request, @Query() query: unknown) {
        return this.recommendations.list(request.principal.id, recommendationsQuerySchema.parse(query));
    }

    @Post('recommendations/events')
    @HttpCode(202)
    @ApiBody({ schema: body(recommendationEventSchema) })
    event(@Req() request: Request, @Body() input: unknown) {
        return this.recommendations.event(request.principal.id, input);
    }

    @Put('authors/:username/follow')
    @HttpCode(200)
    @ApiParam({ name: 'username', schema: { type: 'string', minLength: 1, maxLength: 256 } })
    @ApiBody({ schema: body(authorFollowSchema) })
    follow(@Req() request: Request, @Param('username') username: string, @Body() input: unknown) {
        return this.recommendations.follow(request.principal.id, z.string().min(1).max(256).parse(username), input);
    }

    @Get('authors/:username/follow')
    @ApiParam({ name: 'username', schema: { type: 'string', minLength: 1, maxLength: 256 } })
    followState(@Req() request: Request, @Param('username') username: string) {
        return this.recommendations.followState(request.principal.id, z.string().min(1).max(256).parse(username));
    }

    @Get('profile/following')
    @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', maxLength: 2000 } })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } })
    following(@Req() request: Request, @Query() query: unknown) {
        return this.recommendations.following(request.principal.id, authorFollowingQuerySchema.parse(query));
    }
}
