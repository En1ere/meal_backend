import { BadRequestException, Body, Controller, Get, HttpCode, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { ProfilesService } from './profiles.service.js';
import { updateOwnProfileSchema } from './profiles.schemas.js';

type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as Schema;

@ApiTags('profiles')
@Controller()
export class ProfilesController {
    constructor(private readonly profiles: ProfilesService) {}
    @Get('profile')
    @ApiCookieAuth('meal_user')
    @UseGuards(UserSessionGuard)
    own(@Req() request: FastifyRequest & { principal: Principal }) {
        return this.profiles.own(request.principal.id);
    }

    @Put('profile')
    @HttpCode(200)
    @ApiBody({ schema: body(updateOwnProfileSchema) })
    @ApiCookieAuth('meal_user')
    @UseGuards(UserSessionGuard)
    update(@Req() request: FastifyRequest & { principal: Principal }, @Body() body: unknown) {
        return this.profiles.update(request.principal.id, body);
    }

    @Get('authors/:username')
    @ApiParam({ name: 'username', required: true, schema: { type: 'string', minLength: 1, maxLength: 256 } })
    public(@Param('username') username: string) {
        if (!username || username.length > 256) throw new BadRequestException();
        return this.profiles.public(username);
    }
}
