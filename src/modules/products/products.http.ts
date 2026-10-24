import { Controller, Get, Post, Body, Query, Param, Req, UseGuards, HttpCode } from '@nestjs/common';
import { ApiQuery, ApiBody, ApiCookieAuth, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../auth/auth.service.js';
import { UserSessionGuard } from '../auth/auth.http.js';
import { ProductsService } from './products.service.js';
import { productSearchSchema, productProposalSchema } from './products.contracts.js';
type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
@ApiTags('products')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('products')
export class ProductsController {
    constructor(private readonly products: ProductsService) {}
    @ApiQuery({ name: 'q', required: false, schema: { type: 'string' } })
    @ApiQuery({ name: 'barcode', required: false, schema: { type: 'string' } })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer' } })
    @ApiQuery({ name: 'offset', required: false, schema: { type: 'integer' } })
    @Get()
    list(@Req() req: Request, @Query() q: unknown) {
        return this.products.list(req.principal.id, productSearchSchema.parse(q));
    }
    @Get('reference') references(@Req() req: Request) {
        return this.products.references(req.principal.id);
    }
    @Get(':id') @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } }) detail(
        @Req() req: Request,
        @Param('id') id: string,
    ) {
        return this.products.detail(req.principal.id, z.uuid().parse(id));
    }
    @Post('proposals')
    @HttpCode(200)
    @ApiBody({ schema: z.toJSONSchema(productProposalSchema, { io: 'input', target: 'openapi-3.0' }) as Schema })
    propose(@Req() req: Request, @Body() body: unknown) {
        return this.products.propose(req.principal.id, productProposalSchema.parse(body));
    }
}
