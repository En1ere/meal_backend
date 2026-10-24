import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { requireVersion } from '../inventory/inventory.domain.js';
import {
    diaryArchiveSchema,
    diaryCreateSchema,
    diaryMediaUploadSchema,
    diaryPortionDecisionSchema,
    diaryUpdateSchema,
} from './diary.contracts.js';
import { DiaryService } from './diary.service.js';

type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const schema = (value: z.ZodType): Schema => z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;

@ApiTags('diary')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('diary')
export class DiaryController {
    constructor(private readonly diary: DiaryService) {}

    @Get()
    @ApiQuery({ name: 'date', required: true, schema: { type: 'string', format: 'date' } })
    day(@Req() request: Request, @Query('date') date: string) {
        return this.diary.day(request.principal.id, z.iso.date().parse(date));
    }

    @Get('sources')
    @ApiQuery({
        name: 'type',
        required: true,
        schema: { type: 'string', enum: ['ingredient', 'inventory_batch', 'recipe'] },
    })
    @ApiQuery({ name: 'q', required: false, schema: { type: 'string' } })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer' } })
    sources(@Req() request: Request, @Query() query: unknown) {
        const input = z
            .strictObject({
                type: z.enum(['ingredient', 'inventory_batch', 'recipe']),
                q: z.string().trim().max(200).default(''),
                limit: z.coerce.number().int().min(1).max(50).default(20),
            })
            .parse(query);
        return this.diary.sources(request.principal.id, input.type, input.q, input.limit);
    }

    @Post()
    @HttpCode(200)
    @ApiBody({ schema: schema(diaryCreateSchema) })
    create(@Req() request: Request, @Body() body: unknown) {
        return this.diary.create(request.principal.id, diaryCreateSchema.parse(body));
    }

    @Post('portions/:id/decision')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiHeader({ name: 'If-Match', required: true, schema: { type: 'string' } })
    @ApiBody({ schema: schema(diaryPortionDecisionSchema) })
    decidePortion(
        @Req() request: Request,
        @Param('id') id: string,
        @Body() body: unknown,
        @Headers('if-match') version: string | undefined,
    ) {
        const input = diaryPortionDecisionSchema.parse(body);
        requireVersion(version, input.expectedVersion);
        return this.diary.decidePortion(request.principal.id, z.uuid().parse(id), input);
    }

    @Post(':id/media')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: schema(diaryMediaUploadSchema) })
    uploadMedia(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
        return this.diary.uploadMedia(request.principal.id, z.uuid().parse(id), diaryMediaUploadSchema.parse(body));
    }

    @Put(':id')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiHeader({ name: 'If-Match', required: true, schema: { type: 'string' } })
    @ApiBody({ schema: schema(diaryUpdateSchema) })
    update(
        @Req() request: Request,
        @Param('id') id: string,
        @Body() body: unknown,
        @Headers('if-match') version: string | undefined,
    ) {
        const input = diaryUpdateSchema.parse(body);
        requireVersion(version, input.expectedVersion);
        return this.diary.update(request.principal.id, z.uuid().parse(id), input);
    }

    @Post(':id/archive')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiHeader({ name: 'If-Match', required: true, schema: { type: 'string' } })
    @ApiBody({ schema: schema(diaryArchiveSchema) })
    archive(
        @Req() request: Request,
        @Param('id') id: string,
        @Body() body: unknown,
        @Headers('if-match') version: string | undefined,
    ) {
        const input = diaryArchiveSchema.parse(body);
        requireVersion(version, input.expectedVersion);
        return this.diary.archive(request.principal.id, z.uuid().parse(id), input);
    }
}
