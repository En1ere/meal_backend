import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    Param,
    Post,
    Put,
    Req,
    Res,
    UnsupportedMediaTypeException,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiCookieAuth, ApiHeader, ApiParam, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {} from '@fastify/multipart';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { mediaReservationRequestSchema } from './media-storage.contracts.js';
import { MediaStorageService } from './media-storage.service.js';

type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as Schema;
const assetId = (value: string) => z.uuid().parse(value);
const token = (value: string | undefined) => {
    const parsed = z
        .string()
        .min(1)
        .max(2_000)
        .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
        .safeParse(value);
    if (!parsed.success) throw new UnauthorizedException();
    return parsed.data;
};

@ApiTags('media')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('media')
export class MediaStorageController {
    constructor(private readonly media: MediaStorageService) {}

    @Post('reservations')
    @HttpCode(201)
    @ApiBody({ schema: body(mediaReservationRequestSchema) })
    reserve(@Req() request: Request, @Body() input: unknown) {
        return this.media.reserve(request.principal.id, mediaReservationRequestSchema.parse(input));
    }

    @Get('assets/:id')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    status(@Req() request: Request, @Param('id') id: string) {
        return this.media.status(assetId(id), request.principal.id);
    }

    @Put('assets/:id/content')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiHeader({ name: 'X-Media-Upload-Token', required: true })
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } },
    })
    async complete(
        @Req() request: Request,
        @Param('id') id: string,
        @Headers('x-media-upload-token') uploadToken: string | undefined,
    ) {
        if (!request.isMultipart()) throw new UnsupportedMediaTypeException('Ожидался multipart/form-data');
        const part = await request.file({ limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 0, parts: 1 } });
        if (!part || part.type !== 'file' || part.fieldname !== 'file') throw new BadRequestException('Ожидался файл');
        return this.media.complete(
            assetId(id),
            request.principal.id,
            token(uploadToken),
            part.file,
            part.mimetype,
            () => part.file.truncated,
        );
    }

    @Post('assets/:id/download-target')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    downloadTarget(@Req() request: Request, @Param('id') id: string) {
        return this.media.createDownloadTarget(assetId(id), request.principal.id);
    }

    @Get('assets/:id/content')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiHeader({ name: 'X-Media-Download-Token', required: true })
    async download(
        @Req() request: Request,
        @Res() reply: FastifyReply,
        @Param('id') id: string,
        @Headers('x-media-download-token') downloadToken: string | undefined,
    ): Promise<void> {
        const result = await this.media.download(assetId(id), request.principal.id, token(downloadToken));
        reply.header('Content-Type', result.mimeType);
        reply.header('Content-Length', result.sizeBytes);
        reply.header('Content-Disposition', 'attachment');
        reply.send(result.body);
        await result.completion;
    }
}
