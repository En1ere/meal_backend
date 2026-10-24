import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { searchQuerySchema } from './search.contracts.js';
import { SearchService } from './search.service.js';

type Request = FastifyRequest & { principal: Principal };

@ApiTags('search')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('search')
export class SearchController {
    constructor(private readonly search: SearchService) {}

    @Get()
    @ApiQuery({ name: 'type', required: true, enum: ['product', 'recipe', 'brand', 'store'] })
    @ApiQuery({ name: 'q', required: true, schema: { type: 'string', minLength: 1, maxLength: 200 } })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } })
    @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', maxLength: 2000 } })
    list(@Req() request: Request, @Query() query: unknown) {
        return this.search.list(request.principal.id, searchQuerySchema.parse(query));
    }
}
