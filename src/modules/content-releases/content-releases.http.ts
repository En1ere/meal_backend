import { Body, Controller, Get, HttpCode, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AdminSessionGuard } from '../admin-auth/admin-auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { ContentReleasesService } from './content-releases.service.js';
import {
    createReleaseSchema,
    releaseCommandSchema,
    releaseValidateSchema,
    saveReleaseSchema,
} from './content-releases.contracts.js';

type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (value: z.ZodType) =>
    z.toJSONSchema(value, { io: 'input', reused: 'inline', target: 'openapi-3.0' }) as Schema;

@ApiTags('admin-content-releases')
@ApiCookieAuth('meal_admin')
@UseGuards(AdminSessionGuard)
@Controller('admin/content-releases')
export class ContentReleasesController {
    constructor(private readonly releases: ContentReleasesService) {}
    @Get() list(@Req() req: FastifyRequest & { principal: Principal }) {
        return this.releases.list(req.principal);
    }
    @Post() @ApiBody({ schema: body(createReleaseSchema) }) create(
        @Req() req: FastifyRequest & { principal: Principal },
        @Body() input: unknown,
    ) {
        return this.releases.create(req.principal, input);
    }
    @Get('history') history(@Req() req: FastifyRequest & { principal: Principal }) {
        return this.releases.history(req.principal);
    }
    @Get('sources') sources(@Req() req: FastifyRequest & { principal: Principal }) {
        return this.releases.sources(req.principal);
    }
    @Get(':id') @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } }) detail(
        @Req() req: FastifyRequest & { principal: Principal },
        @Param('id') id: string,
    ) {
        return this.releases.detail(id, req.principal);
    }
    @Put(':id') @HttpCode(200) @ApiBody({ schema: body(saveReleaseSchema) }) save(
        @Req() req: FastifyRequest & { principal: Principal },
        @Param('id') id: string,
        @Body() input: unknown,
    ) {
        return this.releases.save(req.principal, id, input);
    }
    @Post(':id/validate') @HttpCode(200) @ApiBody({ schema: body(releaseValidateSchema) }) validate(
        @Req() req: FastifyRequest & { principal: Principal },
        @Param('id') id: string,
        @Body() input: unknown,
    ) {
        return this.releases.validate(id, input, req.principal);
    }
    @Post(':id/publish') @HttpCode(200) @ApiBody({ schema: body(releaseCommandSchema) }) publish(
        @Req() req: FastifyRequest & { principal: Principal },
        @Param('id') id: string,
        @Body() input: unknown,
    ) {
        return this.releases.publish(req.principal, id, input);
    }
    @Post(':id/rollback') @HttpCode(200) @ApiBody({ schema: body(releaseCommandSchema) }) rollback(
        @Req() req: FastifyRequest & { principal: Principal },
        @Param('id') id: string,
        @Body() input: unknown,
    ) {
        return this.releases.rollback(req.principal, id, input);
    }
    @Post(':id/edit') @HttpCode(200) @ApiBody({ schema: body(createReleaseSchema) }) edit(
        @Req() req: FastifyRequest & { principal: Principal },
        @Param('id') id: string,
        @Body() input: unknown,
    ) {
        return this.releases.editFromCurrent(req.principal, id, input);
    }
}

@ApiTags('achievements')
@Controller()
export class AchievementsController {
    constructor(private readonly releases: ContentReleasesService) {}
    @Get('reputation/levels') levels() {
        return this.releases.publicLevels();
    }
    @Get('authors/:username/achievements') achievements(@Param('username') username: string) {
        return this.releases.authorAchievements(username);
    }
    @Get('authors/:username/reputation') reputation(@Param('username') username: string) {
        return this.releases.authorReputation(username);
    }
}
