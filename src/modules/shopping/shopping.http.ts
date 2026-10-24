import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { ShoppingService } from './shopping.service.js';
import {
    shoppingCreateSchema,
    shoppingAddSchema,
    shoppingEditSchema,
    shoppingPreviewQuerySchema,
    shoppingScopeQuerySchema,
} from './shopping.contracts.js';
type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as Schema;
@ApiTags('shopping')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('shopping-lists')
export class ShoppingController {
    constructor(private readonly shopping: ShoppingService) {}

    @Post(':id/command')
    @HttpCode(200)
    @ApiBody({ schema: body(shoppingCommandSchema) })
    command(@Req() r: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.shopping.command(r.principal.id, z.uuid().parse(id), shoppingCommandSchema.parse(input));
    }
    @Post(':id/reorder')
    @HttpCode(200)
    @ApiBody({ schema: body(shoppingReorderSchema) })
    reorder(@Req() r: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.shopping.reorder(r.principal.id, z.uuid().parse(id), shoppingReorderSchema.parse(input));
    }
    @Post(':id/purchase-preview')
    @HttpCode(200)
    @ApiBody({ schema: body(purchaseReviewSchema) })
    purchasePreview(@Req() r: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.shopping.purchasePreview(r.principal.id, z.uuid().parse(id), purchaseReviewSchema.parse(input));
    }
    @Post(':id/purchase-commit')
    @HttpCode(200)
    @ApiBody({ schema: body(purchaseCommitSchema) })
    purchaseCommit(@Req() r: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.shopping.purchaseCommit(r.principal.id, z.uuid().parse(id), purchaseCommitSchema.parse(input));
    }
    @Get()
    @ApiQuery({ name: 'q', required: false, schema: { type: 'string', maxLength: 200, default: '' } })
    @ApiQuery({ name: 'status', required: false, enum: ['active', 'completed', 'archived', 'all'] })
    @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', format: 'uuid' } })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 } })
    @ApiQuery({ name: 'scope', required: false, enum: ['private', 'family'] })
    list(@Req() req: Request, @Query() query: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
        reply.header('Cache-Control', 'private, no-store');
        return this.shopping.list(req.principal.id, shoppingListQuerySchema.parse(query));
    }
    @Get('recipe-preview')
    @ApiQuery({ name: 'recipeId', schema: { type: 'string', format: 'uuid' } })
    @ApiQuery({ name: 'servings', schema: { type: 'integer', minimum: 1, maximum: 1000 } })
    @ApiQuery({ name: 'scope', required: false, enum: ['private', 'family'] })
    preview(@Req() req: Request, @Query() input: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
        reply.header('Cache-Control', 'private, no-store');
        const q = shoppingPreviewQuerySchema.parse(input);
        return this.shopping.preview(req.principal.id, q.recipeId, q.servings);
    }
    @Get(':id/history')
    @ApiQuery({ name: 'scope', required: false, enum: ['private', 'family'] })
    history(
        @Req() req: Request,
        @Param('id') id: string,
        @Query() query: unknown,
        @Res({ passthrough: true }) reply: FastifyReply,
    ) {
        reply.header('Cache-Control', 'private, no-store');
        return this.shopping.history(req.principal.id, z.uuid().parse(id), shoppingScopeQuerySchema.parse(query).scope);
    }
    @Get(':id')
    @ApiQuery({ name: 'scope', required: false, enum: ['private', 'family'] })
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    detail(
        @Req() req: Request,
        @Param('id') id: string,
        @Query() query: unknown,
        @Res({ passthrough: true }) reply: FastifyReply,
    ) {
        reply.header('Cache-Control', 'private, no-store');
        return this.shopping.detail(req.principal.id, z.uuid().parse(id), shoppingScopeQuerySchema.parse(query).scope);
    }
    @Post()
    @HttpCode(200)
    @ApiBody({ schema: body(shoppingCreateSchema) })
    create(@Req() req: Request, @Body() input: unknown) {
        return this.shopping.create(req.principal.id, shoppingCreateSchema.parse(input));
    }
    @Post(':id/items')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(shoppingAddSchema) })
    add(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.shopping.add(req.principal.id, z.uuid().parse(id), shoppingAddSchema.parse(input));
    }
    @Post(':id/items/:itemId')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiParam({ name: 'itemId', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(shoppingEditSchema) })
    edit(@Req() req: Request, @Param('id') id: string, @Param('itemId') itemId: string, @Body() input: unknown) {
        return this.shopping.edit(
            req.principal.id,
            z.uuid().parse(id),
            z.uuid().parse(itemId),
            shoppingEditSchema.parse(input),
        );
    }
}
import { shoppingListQuerySchema, shoppingCommandSchema, shoppingReorderSchema } from './shopping.contracts.js';
import { purchaseReviewSchema, purchaseCommitSchema } from '../receipts/receipts.contracts.js';
