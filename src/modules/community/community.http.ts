import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { communityCommentsQuerySchema, communityQuerySchema } from './community.contracts.js';
import { CommunityService } from './community.service.js';

@ApiTags('community')
@Controller('community')
export class CommunityController {
    constructor(private readonly community: CommunityService) {}

    @Get()
    @ApiQuery({ name: 'q', required: false, schema: { type: 'string', maxLength: 200, default: '' } })
    @ApiQuery({ name: 'category', required: false, schema: { type: 'string', minLength: 1, maxLength: 100 } })
    @ApiQuery({ name: 'author', required: false, schema: { type: 'string', minLength: 1, maxLength: 256 } })
    @ApiQuery({ name: 'sort', required: false, enum: ['newest', 'oldest'] })
    @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', maxLength: 2000 } })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } })
    feed(@Query() query: unknown) {
        return this.community.feed(communityQuerySchema.parse(query));
    }

    @Get('recipes/:id/comments')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', maxLength: 2000 } })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } })
    comments(@Param('id') id: string, @Query() query: unknown) {
        return this.community.comments(z.uuid().parse(id), communityCommentsQuerySchema.parse(query));
    }
}
