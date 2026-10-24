import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiCreatedResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import {
    familyNoteArchiveSchema,
    familyNoteCreateSchema,
    familyNotesQuerySchema,
    familyNoteToggleSchema,
    familyNoteUpdateSchema,
} from './family-notes.contracts.js';
import { FamilyNotesService } from './family-notes.service.js';

type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as Schema;

@ApiTags('family-notes')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('family/notes')
export class FamilyNotesController {
    constructor(private readonly service: FamilyNotesService) {}

    @Get()
    @ApiQuery({ name: 'q', required: false, schema: { type: 'string', maxLength: 100, default: '' } })
    @ApiQuery({
        name: 'tab',
        required: false,
        schema: { type: 'string', enum: ['active', 'archived'], default: 'active' },
    })
    list(@Req() request: Request, @Query() query: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
        reply.header('Cache-Control', 'private, no-store');
        return this.service.list(request.principal.id, familyNotesQuerySchema.parse(query));
    }

    @Get(':id')
    detail(@Req() request: Request, @Param('id') id: string) {
        return this.service.detail(request.principal.id, z.uuid().parse(id));
    }

    @Get(':id/history')
    history(@Req() request: Request, @Param('id') id: string) {
        return this.service.history(request.principal.id, z.uuid().parse(id));
    }

    @Post()
    @HttpCode(201)
    @ApiCreatedResponse({ description: 'Family note created' })
    @ApiBody({ schema: body(familyNoteCreateSchema) })
    create(@Req() request: Request, @Body() input: unknown) {
        return this.service.create(request.principal.id, familyNoteCreateSchema.parse(input));
    }

    @Put(':id')
    @ApiBody({ schema: body(familyNoteUpdateSchema) })
    update(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.service.update(request.principal.id, z.uuid().parse(id), familyNoteUpdateSchema.parse(input));
    }

    @Post(':id/archive')
    @HttpCode(200)
    @ApiBody({ schema: body(familyNoteArchiveSchema) })
    archive(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.service.archive(request.principal.id, z.uuid().parse(id), familyNoteArchiveSchema.parse(input));
    }

    @Post(':id/items/:itemId/toggle')
    @HttpCode(200)
    @ApiBody({ schema: body(familyNoteToggleSchema) })
    toggle(@Req() request: Request, @Param('id') id: string, @Param('itemId') itemId: string, @Body() input: unknown) {
        return this.service.toggle(
            request.principal.id,
            z.uuid().parse(id),
            z.uuid().parse(itemId),
            familyNoteToggleSchema.parse(input),
        );
    }
}
