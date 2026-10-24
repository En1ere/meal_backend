import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiQuery, ApiBody, ApiCookieAuth, ApiHeader, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { InventoryService, inventoryQuerySchema } from './inventory.service.js';
import {
    inventoryCreateSchema,
    inventoryImportSchema,
    inventoryCommandSchema,
    inventoryLocationCommandSchema,
    inventoryScopeSchema,
} from './inventory.contracts.js';
import { requireVersion } from './inventory.domain.js';
type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
function schema(value: z.ZodType): Schema {
    return z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;
}
@ApiTags('inventory')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller()
export class InventoryController {
    constructor(private readonly inventory: InventoryService) {}
    @ApiQuery({ name: 'q', required: false, schema: { type: 'string' } })
    @ApiQuery({ name: 'status', required: false, schema: { type: 'string' } })
    @ApiQuery({ name: 'attention', required: false, schema: { type: 'string' } })
    @ApiQuery({ name: 'days', required: false, schema: { type: 'integer' } })
    @ApiQuery({ name: 'localDate', required: true, schema: { type: 'string' } })
    @ApiQuery({ name: 'locationId', required: false, schema: { type: 'string' } })
    @ApiQuery({ name: 'ingredientId', required: false, schema: { type: 'string' } })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer' } })
    @ApiQuery({ name: 'offset', required: false, schema: { type: 'integer' } })
    @ApiQuery({ name: 'scope', required: false, schema: { type: 'string', enum: ['private', 'family'] } })
    @Get('inventory')
    list(@Req() req: Request, @Query() query: unknown) {
        return this.inventory.list(req.principal.id, inventoryQuerySchema.parse(query));
    }
    @Get('inventory-locations')
    @ApiQuery({ name: 'scope', required: false, schema: { type: 'string', enum: ['private', 'family'] } })
    locations(@Req() req: Request, @Query('scope') scope: string | undefined) {
        return this.inventory.locations(req.principal.id, inventoryScopeSchema.default('private').parse(scope));
    }
    @ApiHeader({
        name: 'If-Match',
        required: false,
        description: 'Required for rename: quoted current version',
        schema: { type: 'string' },
    })
    @Post('inventory-locations')
    @HttpCode(200)
    @ApiBody({ schema: schema(inventoryLocationCommandSchema) })
    location(@Req() req: Request, @Body() body: unknown, @Headers('if-match') version: string | undefined) {
        const input = inventoryLocationCommandSchema.parse(body);
        if (input.action === 'rename') requireVersion(version, input.version);
        return this.inventory.location(req.principal.id, input);
    }
    @ApiQuery({ name: 'batchId', required: false, schema: { type: 'string' } })
    @ApiQuery({ name: 'q', required: false, schema: { type: 'string' } })
    @ApiQuery({ name: 'action', required: false, schema: { type: 'string' } })
    @ApiQuery({ name: 'from', required: false, schema: { type: 'string' } })
    @ApiQuery({ name: 'to', required: false, schema: { type: 'string' } })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer' } })
    @ApiQuery({ name: 'offset', required: false, schema: { type: 'integer' } })
    @ApiQuery({ name: 'scope', required: false, schema: { type: 'string', enum: ['private', 'family'] } })
    @Get('inventory-history')
    history(@Req() req: Request, @Query() query: unknown) {
        const value = z
            .object({
                batchId: z.uuid().optional(),
                q: z.string().max(200).optional(),
                action: z
                    .enum(['purchase', 'consume', 'cook', 'adjust', 'transfer', 'archive', 'restore', 'compensate'])
                    .optional(),
                from: z.iso.datetime().optional(),
                to: z.iso.datetime().optional(),
                limit: z.coerce.number().int().min(1).max(100).default(100),
                offset: z.coerce.number().int().min(0).max(100000).default(0),
                scope: inventoryScopeSchema.default('private'),
            })
            .strict()
            .parse(query);
        return this.inventory.history(req.principal.id, value.scope, value.batchId, value.limit, value.offset, value);
    }
    @Get('inventory/:id')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiQuery({ name: 'scope', required: false, schema: { type: 'string', enum: ['private', 'family'] } })
    detail(@Req() req: Request, @Param('id') id: string, @Query('scope') scope: string | undefined) {
        return this.inventory.detail(
            req.principal.id,
            z.uuid().parse(id),
            inventoryScopeSchema.default('private').parse(scope),
        );
    }
    @Post('inventory/import/commit')
    @HttpCode(200)
    @ApiBody({ schema: schema(inventoryImportSchema) })
    importMany(@Req() req: Request, @Body() body: unknown) {
        return this.inventory.importMany(req.principal.id, inventoryImportSchema.parse(body));
    }
    @Post('inventory')
    @HttpCode(200)
    @ApiBody({ schema: schema(inventoryCreateSchema) })
    create(@Req() req: Request, @Body() body: unknown) {
        return this.inventory.create(req.principal.id, inventoryCreateSchema.parse(body));
    }
    @ApiHeader({
        name: 'If-Match',
        required: true,
        description: 'Quoted batch version, e.g. "1"',
        schema: { type: 'string' },
    })
    @Post('inventory/:id/command')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: schema(inventoryCommandSchema) })
    command(
        @Req() req: Request,
        @Param('id') id: string,
        @Body() body: unknown,
        @Headers('if-match') version: string | undefined,
    ) {
        const input = inventoryCommandSchema.parse(body);
        requireVersion(version, input.version);
        return this.inventory.command(req.principal.id, z.uuid().parse(id), input);
    }
}
