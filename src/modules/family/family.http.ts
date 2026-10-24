import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiCreatedResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import {
    familyCreateSchema,
    familyLeaveSchema,
    familyMemberRemoveSchema,
    familyInvitationAcceptSchema,
    familyInvitationCreateSchema,
    familyInvitationDecisionSchema,
    ownershipNoticeDismissSchema,
    ownershipPreviewInputSchema,
    ownershipRequestCreateSchema,
    ownershipRequestDecisionSchema,
} from './family.contracts.js';
import { FamilyService } from './family.service.js';

type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const body = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as Schema;

@ApiTags('family')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('family')
export class FamilyController {
    constructor(private readonly service: FamilyService) {}

    @Get()
    get(@Req() request: Request) {
        return this.service.context(request.principal.id);
    }

    @Post()
    @HttpCode(201)
    @ApiCreatedResponse({ description: 'Family created' })
    @ApiBody({ schema: body(familyCreateSchema) })
    create(@Req() request: Request, @Body() input: unknown) {
        return this.service.create(input, request.principal, request.id);
    }

    @Get('leave-preview')
    leavePreview(@Req() request: Request) {
        return this.service.leavePreview(request.principal.id);
    }

    @Post('leave')
    @HttpCode(200)
    @ApiBody({ schema: body(familyLeaveSchema) })
    leave(@Req() request: Request, @Body() input: unknown) {
        return this.service.leave(input, request.principal, request.id);
    }

    @Post('members/:membershipId/remove')
    @HttpCode(200)
    @ApiBody({ schema: body(familyMemberRemoveSchema) })
    removeMember(@Req() request: Request, @Param('membershipId') membershipId: string, @Body() input: unknown) {
        return this.service.removeMember(z.uuid().parse(membershipId), input, request.principal, request.id);
    }

    @Get('ownership-notice')
    ownershipNotice(@Req() request: Request) {
        return this.service.ownershipNotice(request.principal.id);
    }

    @Post('ownership-notice/dismiss')
    @HttpCode(200)
    @ApiBody({ schema: body(ownershipNoticeDismissSchema) })
    dismissOwnershipNotice(@Req() request: Request, @Body() input: unknown) {
        return this.service.dismissOwnershipNotice(input, request.principal);
    }

    @Get('ownership')
    ownership(@Req() request: Request) {
        return this.service.ownershipWorkspace(request.principal);
    }

    @Post('ownership/preview')
    @HttpCode(200)
    @ApiBody({ schema: body(ownershipPreviewInputSchema) })
    ownershipPreview(@Req() request: Request, @Body() input: unknown) {
        return this.service.ownershipPreview(input, request.principal);
    }

    @Post('ownership/requests')
    @HttpCode(201)
    @ApiCreatedResponse({ description: 'Ownership request created' })
    @ApiBody({ schema: body(ownershipRequestCreateSchema) })
    createOwnershipRequest(@Req() request: Request, @Body() input: unknown) {
        return this.service.createOwnershipRequest(input, request.principal);
    }

    @Get('ownership/requests/:token')
    @ApiParam({ name: 'token', schema: { type: 'string', format: 'uuid' } })
    ownershipRequest(@Req() request: Request, @Param('token') token: string) {
        return this.service.ownershipRequest(request.principal, z.uuid().parse(token));
    }

    @Post('ownership/requests/:token/accept')
    @HttpCode(200)
    @ApiParam({ name: 'token', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(ownershipRequestDecisionSchema) })
    acceptOwnership(@Req() request: Request, @Param('token') token: string, @Body() input: unknown) {
        return this.service.decideOwnershipRequest('accept', z.uuid().parse(token), input, request.principal);
    }

    @Post('ownership/requests/:token/decline')
    @HttpCode(200)
    @ApiParam({ name: 'token', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(ownershipRequestDecisionSchema) })
    declineOwnership(@Req() request: Request, @Param('token') token: string, @Body() input: unknown) {
        return this.service.decideOwnershipRequest('decline', z.uuid().parse(token), input, request.principal);
    }

    @Post('ownership/requests/:token/cancel')
    @HttpCode(200)
    @ApiParam({ name: 'token', schema: { type: 'string', format: 'uuid' } })
    @ApiBody({ schema: body(ownershipRequestDecisionSchema) })
    cancelOwnership(@Req() request: Request, @Param('token') token: string, @Body() input: unknown) {
        return this.service.decideOwnershipRequest('cancel', z.uuid().parse(token), input, request.principal);
    }

    @Get('invitations')
    invitations(@Req() request: Request) {
        return this.service.invitations(request.principal.id);
    }

    @Post('invitations')
    @HttpCode(201)
    @ApiCreatedResponse({ description: 'Invitation or invitation proposal created' })
    @ApiBody({ schema: body(familyInvitationCreateSchema) })
    invite(@Req() request: Request, @Body() input: unknown) {
        return this.service.invite(input, request.principal, request.id);
    }

    @Post('invitations/:invitationId/approve')
    @HttpCode(200)
    @ApiBody({ schema: body(familyInvitationDecisionSchema) })
    approveInvitation(@Req() request: Request, @Param('invitationId') invitationId: string, @Body() input: unknown) {
        return this.service.approveInvitation(z.uuid().parse(invitationId), input, request.principal, request.id);
    }

    @Post('invitations/:invitationId/cancel')
    @HttpCode(200)
    @ApiBody({ schema: body(familyInvitationDecisionSchema) })
    cancelInvitation(@Req() request: Request, @Param('invitationId') invitationId: string, @Body() input: unknown) {
        return this.service.cancelInvitation(z.uuid().parse(invitationId), input, request.principal, request.id);
    }

    @Get('invitation-preview')
    invitationPreview(@Req() request: Request, @Query('token') token: string) {
        return this.service.invitationPreview(request.principal.id, token);
    }

    @Post('invitation-accept')
    @HttpCode(200)
    @ApiBody({ schema: body(familyInvitationAcceptSchema) })
    acceptInvitation(@Req() request: Request, @Body() input: unknown) {
        return this.service.acceptInvitation(input, request.principal, request.id);
    }
}
