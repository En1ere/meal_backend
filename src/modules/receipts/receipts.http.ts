import { Body, Controller, Get, Post, Param, Query, Req, UseGuards, HttpCode, Header } from '@nestjs/common';
import { ApiBody, ApiTags, ApiCookieAuth, ApiQuery } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { ReceiptsService } from './receipts.service.js';
import {
    receiptCreateSchema,
    receiptEditSchema,
    receiptLinkSchema,
    purchaseReviewSchema,
    purchaseCommitSchema,
    receiptScopeQuerySchema,
} from './receipts.contracts.js';
type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as Schema;
@ApiTags('receipts')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('receipts')
export class ReceiptsController {
    constructor(private readonly service: ReceiptsService) {}
    @Header('Cache-Control', 'private, no-store')
    @Get('capabilities')
    capabilities() {
        return this.service.capabilities();
    }
    @Header('Cache-Control', 'private, no-store')
    @Get(':id')
    @ApiQuery({ name: 'scope', required: false, enum: ['private', 'family'] })
    detail(@Req() r: Request, @Param('id') id: string, @Query() query: unknown) {
        return this.service.detail(r.principal.id, z.uuid().parse(id), receiptScopeQuerySchema.parse(query).scope);
    }
    @Header('Cache-Control', 'private, no-store')
    @Post()
    @HttpCode(200)
    @ApiBody({ schema: body(receiptCreateSchema) })
    create(@Req() r: Request, @Body() input: unknown) {
        return this.service.create(r.principal.id, receiptCreateSchema.parse(input));
    }
    @Header('Cache-Control', 'private, no-store')
    @Post(':id/edit')
    @HttpCode(200)
    @ApiBody({ schema: body(receiptEditSchema) })
    edit(@Req() r: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.service.edit(r.principal.id, z.uuid().parse(id), receiptEditSchema.parse(input));
    }
    @Header('Cache-Control', 'private, no-store')
    @Post(':id/intake-preview')
    @HttpCode(200)
    @ApiBody({ schema: body(purchaseReviewSchema) })
    preview(@Req() r: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.service.preview(r.principal.id, z.uuid().parse(id), purchaseReviewSchema.parse(input));
    }
    @Header('Cache-Control', 'private, no-store')
    @Post(':id/commit')
    @HttpCode(200)
    @ApiBody({ schema: body(purchaseCommitSchema) })
    commit(@Req() r: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.service.commit(r.principal.id, z.uuid().parse(id), purchaseCommitSchema.parse(input));
    }
    @Header('Cache-Control', 'private, no-store')
    @Get(':id/duplicates')
    @ApiQuery({ name: 'scope', required: false, enum: ['private', 'family'] })
    duplicates(@Req() r: Request, @Param('id') id: string, @Query() query: unknown) {
        return this.service.duplicates(r.principal.id, z.uuid().parse(id), receiptScopeQuerySchema.parse(query).scope);
    }
    @Header('Cache-Control', 'private, no-store')
    @Post(':id/link-purchase')
    @HttpCode(200)
    @ApiBody({ schema: body(receiptLinkSchema) })
    link(@Req() r: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.service.link(r.principal.id, z.uuid().parse(id), receiptLinkSchema.parse(input));
    }
}
import { PurchasesService } from './purchases.service.js';
import { purchaseResolveSchema, purchaseResolveCommitSchema } from './receipts.contracts.js';
@ApiTags('purchases')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('purchases')
export class PurchasesController {
    constructor(private readonly service: PurchasesService) {}
    @Header('Cache-Control', 'private, no-store')
    @Get(':id')
    @ApiQuery({ name: 'scope', required: false, enum: ['private', 'family'] })
    detail(@Req() r: Request, @Param('id') id: string, @Query() query: unknown) {
        return this.service.detail(r.principal.id, z.uuid().parse(id), receiptScopeQuerySchema.parse(query).scope);
    }
    @Header('Cache-Control', 'private, no-store')
    @Post(':id/resolve-preview')
    @HttpCode(200)
    @ApiBody({ schema: body(purchaseResolveSchema) })
    preview(@Req() r: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.service.preview(r.principal.id, z.uuid().parse(id), purchaseResolveSchema.parse(input));
    }
    @Header('Cache-Control', 'private, no-store')
    @Post(':id/resolve-commit')
    @HttpCode(200)
    @ApiBody({ schema: body(purchaseResolveCommitSchema) })
    commit(@Req() r: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.service.commit(r.principal.id, z.uuid().parse(id), purchaseResolveCommitSchema.parse(input));
    }
}
