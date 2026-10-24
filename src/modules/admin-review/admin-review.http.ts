import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiParam, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AdminSessionGuard } from '../admin-auth/admin-auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { reviewPreviewSchema, reviewExecuteSchema, reviewParamsSchema } from './admin-review.contracts.js';
import { AdminReviewService } from './admin-review.service.js';
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
type Request = FastifyRequest & { principal: Principal };
const schema = (value: z.ZodType) => z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;
@ApiTags('admin-review')
@ApiCookieAuth('meal_admin')
@UseGuards(AdminSessionGuard)
@ApiParam({ name: 'section', enum: ['legal-requests', 'rollback'] })
@ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
@Controller('admin/review-workspace/:section/:id')
export class AdminReviewController {
    constructor(private readonly service: AdminReviewService) {}
    @Get() load(@Req() request: Request, @Param() raw: unknown) {
        const params = reviewParamsSchema.parse(raw);
        return this.service.load(params.section, params.id, request.principal, request.id);
    }
    @Post('preview') @HttpCode(200) @ApiBody({ schema: schema(reviewPreviewSchema) }) preview(
        @Req() request: Request,
        @Param() raw: unknown,
        @Body() body: unknown,
    ) {
        const params = reviewParamsSchema.parse(raw);
        const input = reviewPreviewSchema.parse(body);
        return this.service.preview(params.section, params.id, input.version, request.principal, request.id);
    }
    @Post('prepare-export') @HttpCode(200) @ApiBody({ schema: schema(reviewExecuteSchema) }) prepareExport(
        @Param() raw: unknown,
        @Body() body: unknown,
    ) {
        const params = reviewParamsSchema.parse(raw);
        reviewExecuteSchema.parse(body);
        return this.service.prepareExport(params.section);
    }
    @Post('apply-rollback') @HttpCode(200) @ApiBody({ schema: schema(reviewExecuteSchema) }) applyRollback(
        @Req() request: Request,
        @Param() raw: unknown,
        @Body() body: unknown,
    ) {
        const params = reviewParamsSchema.parse(raw);
        const input = reviewExecuteSchema.parse(body);
        return this.service.applyRollback(params.section, params.id, input, request.principal, request.id);
    }
}
