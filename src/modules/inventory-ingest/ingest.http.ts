import { Controller, Post, Req, UseGuards, HttpCode } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { UserSessionGuard } from '../auth/auth.http.js';
import { InventoryIngestService } from './ingest.service.js';
import type { Principal } from '../auth/auth.service.js';

@ApiTags('inventory-ingest')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('inventory/ingest')
export class InventoryIngestController {
    constructor(private readonly ingest: InventoryIngestService) {}
    @Post('import')
    @HttpCode(200)
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } },
    })
    import(@Req() request: FastifyRequest & { principal: Principal }) {
        return this.ingest.preview(request, 'table', request.principal.id);
    }
    @Post('scan')
    @HttpCode(200)
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        schema: {
            type: 'object',
            required: ['files'],
            properties: {
                files: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', format: 'binary' } },
            },
        },
    })
    scan(@Req() request: FastifyRequest & { principal: Principal }) {
        return this.ingest.preview(request, 'scan', request.principal.id);
    }
}
