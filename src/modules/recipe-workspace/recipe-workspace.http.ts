import { Controller, Get, Post, Put, Patch, Param, Query, Body, Req, Res, UseGuards, HttpCode } from '@nestjs/common';
import { ApiTags, ApiCookieAuth, ApiBody, ApiParam, ApiQuery } from '@nestjs/swagger';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { RecipeWorkspaceService } from './recipe-workspace.service.js';
import {
    workspaceQuerySchema,
    workspaceCreateSchema,
    workspaceSaveSchema,
    workspaceCommandSchema,
    workspaceVariantSchema,
    workspaceRatingSchema,
    workspaceCommentSchema,
    workspaceCommentEditSchema,
    workspaceReportSchema,
    workspaceReportsQuerySchema,
    workspaceDetailQuerySchema,
} from './recipe-workspace.contracts.js';
type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (schema: z.ZodType) =>
    ApiBody({ schema: z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as Schema });
@ApiTags('recipe-workspace')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('recipe-workspace')
export class RecipeWorkspaceController {
    constructor(private readonly workspace: RecipeWorkspaceService) {}
    @Get('reports/:id')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    reportDetail(@Req() req: Request, @Param('id') id: string, @Res({ passthrough: true }) reply: FastifyReply) {
        reply.header('Cache-Control', 'private, no-store');
        return this.workspace.reportDetail(req.principal.id, z.uuid().parse(id));
    }
    @Get('reports')
    @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, maximum: 10000 } })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } })
    reports(@Req() req: Request, @Query() query: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
        reply.header('Cache-Control', 'private, no-store');
        return this.workspace.reports(req.principal.id, workspaceReportsQuerySchema.parse(query));
    }
    @Get()
    @ApiQuery({ name: 'q', required: false, schema: { type: 'string', maxLength: 200 } })
    @ApiQuery({ name: 'scope', required: false, schema: { type: 'string', enum: ['private', 'family'] } })
    @ApiQuery({ name: 'status', required: false, schema: { type: 'string', enum: ['active', 'archived'] } })
    @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, maximum: 10000 } })
    @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } })
    list(@Req() req: Request, @Query() query: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
        reply.header('Cache-Control', 'private, no-store');
        return this.workspace.list(req.principal.id, workspaceQuerySchema.parse(query));
    }
    @Post() @HttpCode(200) @body(workspaceCreateSchema) create(@Req() req: Request, @Body() input: unknown) {
        return this.workspace.create(req.principal.id, workspaceCreateSchema.parse(input));
    }
    @Get(':id')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiQuery({ name: 'scope', required: false, schema: { type: 'string', enum: ['private', 'family'] } })
    detail(
        @Req() req: Request,
        @Param('id') id: string,
        @Query() query: unknown,
        @Res({ passthrough: true }) reply: FastifyReply,
    ) {
        reply.header('Cache-Control', 'private, no-store');
        return this.workspace.detail(req.principal.id, z.uuid().parse(id), workspaceDetailQuerySchema.parse(query));
    }
    @Put(':id')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @body(workspaceSaveSchema)
    save(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.workspace.save(req.principal.id, z.uuid().parse(id), workspaceSaveSchema.parse(input));
    }
    @Post(':id/archive')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @HttpCode(200)
    @body(workspaceCommandSchema)
    archive(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.workspace.command(
            req.principal.id,
            z.uuid().parse(id),
            'archive',
            workspaceCommandSchema.parse(input),
        );
    }
    @Post(':id/restore')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @HttpCode(200)
    @body(workspaceCommandSchema)
    restore(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.workspace.command(
            req.principal.id,
            z.uuid().parse(id),
            'restore',
            workspaceCommandSchema.parse(input),
        );
    }
    @Post(':id/submit')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @HttpCode(200)
    @body(workspaceCommandSchema)
    submit(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.workspace.command(
            req.principal.id,
            z.uuid().parse(id),
            'submit',
            workspaceCommandSchema.parse(input),
        );
    }
    @Post(':id/rollback')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @HttpCode(200)
    @body(workspaceCommandSchema)
    rollback(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.workspace.command(
            req.principal.id,
            z.uuid().parse(id),
            'rollback',
            workspaceCommandSchema.parse(input),
        );
    }
    @Post(':id/variant')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @HttpCode(200)
    @body(workspaceVariantSchema)
    variant(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.workspace.variant(req.principal.id, z.uuid().parse(id), workspaceVariantSchema.parse(input));
    }
    @Get(':id/community')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    community(@Req() req: Request, @Param('id') id: string, @Res({ passthrough: true }) reply: FastifyReply) {
        reply.header('Cache-Control', 'private, no-store');
        return this.workspace.community(req.principal.id, z.uuid().parse(id));
    }
    @Post(':id/rating')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @HttpCode(200)
    @body(workspaceRatingSchema)
    rating(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.workspace.rating(req.principal.id, z.uuid().parse(id), workspaceRatingSchema.parse(input));
    }
    @Post(':id/comments')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @HttpCode(200)
    @body(workspaceCommentSchema)
    comment(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.workspace.comment(req.principal.id, z.uuid().parse(id), workspaceCommentSchema.parse(input));
    }
    @Patch(':id/comments/:commentId')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiParam({ name: 'commentId', schema: { type: 'string', format: 'uuid' } })
    @body(workspaceCommentEditSchema)
    editComment(
        @Req() req: Request,
        @Param('id') id: string,
        @Param('commentId') commentId: string,
        @Body() input: unknown,
    ) {
        return this.workspace.editComment(
            req.principal.id,
            z.uuid().parse(id),
            z.uuid().parse(commentId),
            workspaceCommentEditSchema.parse(input),
        );
    }
    @Post(':id/comments/:commentId/remove')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiParam({ name: 'commentId', schema: { type: 'string', format: 'uuid' } })
    @HttpCode(200)
    @body(workspaceCommandSchema)
    removeComment(
        @Req() req: Request,
        @Param('id') id: string,
        @Param('commentId') commentId: string,
        @Body() input: unknown,
    ) {
        return this.workspace.editComment(
            req.principal.id,
            z.uuid().parse(id),
            z.uuid().parse(commentId),
            workspaceCommandSchema.parse(input),
        );
    }
    @Post(':id/reports')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @HttpCode(200)
    @body(workspaceReportSchema)
    report(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.workspace.report(req.principal.id, z.uuid().parse(id), workspaceReportSchema.parse(input));
    }
}
