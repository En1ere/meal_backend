import {
    Body,
    Controller,
    ForbiddenException,
    Get,
    HttpCode,
    Injectable,
    Param,
    Post,
    Query,
    Req,
    UseGuards,
    type CanActivate,
    type ExecutionContext,
} from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { StaffSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import {
    moderatorClaimSchema,
    moderatorDecisionSchema,
    moderatorQueueSchema,
    moderatorSupportReopenSchema,
    moderatorSupportReplySchema,
} from './moderator.contracts.js';
import { ModeratorService } from './moderator.service.js';

type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const schema = (value: z.ZodType) => z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;

@Injectable()
export class ModeratorSessionGuard implements CanActivate {
    constructor(private readonly staff: StaffSessionGuard) {}
    async canActivate(context: ExecutionContext) {
        await this.staff.canActivate(context);
        const request = context.switchToHttp().getRequest<Request>();
        if (request.principal.context !== 'moderator') throw new ForbiddenException();
        return true;
    }
}

@ApiTags('moderator')
@ApiCookieAuth('meal_staff')
@UseGuards(ModeratorSessionGuard)
@Controller('moderator')
export class ModeratorController {
    constructor(private readonly service: ModeratorService) {}

    @Get('overview')
    overview(@Req() request: Request) {
        return this.service.overview(request.principal);
    }

    @Get('queues/:queue')
    queue(
        @Param('queue') queue: string,
        @Query('status') status: string | undefined,
        @Query('assignment') assignment: string | undefined,
        @Query('priority') priority: string | undefined,
        @Query('cursor') cursor: string | undefined,
        @Req() request: Request,
    ) {
        return this.service.queue(
            moderatorQueueSchema.parse(queue),
            { status, assignment, priority, cursor },
            request.principal,
        );
    }

    @Get('items/:id')
    item(@Param('id') id: string, @Req() request: Request) {
        return this.service.item(z.uuid().parse(id), request.principal);
    }

    @Post('items/:id/claim')
    @HttpCode(200)
    @ApiBody({ schema: schema(moderatorClaimSchema) })
    claim(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
        return this.service.claim(z.uuid().parse(id), body, request.principal, request.id);
    }

    @Post('items/:id/skip')
    @HttpCode(200)
    @ApiBody({ schema: schema(moderatorClaimSchema) })
    skip(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
        return this.service.skip(z.uuid().parse(id), body, request.principal, request.id);
    }

    @Post('items/:id/decision')
    @HttpCode(200)
    @ApiBody({ schema: schema(moderatorDecisionSchema) })
    decision(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
        return this.service.decision(z.uuid().parse(id), body, request.principal, request.id);
    }

    @Get('support/:id')
    support(@Param('id') id: string, @Req() request: Request) {
        return this.service.support(z.uuid().parse(id), request.principal);
    }

    @Post('support/:id/reply')
    @HttpCode(200)
    @ApiBody({ schema: schema(moderatorSupportReplySchema) })
    reply(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
        return this.service.reply(z.uuid().parse(id), body, request.principal, request.id);
    }

    @Post('support/:id/reopen')
    @HttpCode(200)
    @ApiBody({ schema: schema(moderatorSupportReopenSchema) })
    reopen(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
        return this.service.reopen(z.uuid().parse(id), body, request.principal, request.id);
    }
}
