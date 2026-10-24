import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    Get,
    HttpCode,
    Injectable,
    Post,
    Req,
    Res,
    UseGuards,
    type CanActivate,
    type ExecutionContext,
} from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthCookies, mfaSchema } from '../auth/auth.http.js';
import { AuthService, type Principal } from '../auth/auth.service.js';
import { AdminAccessService } from './admin-access.service.js';

export const adminLoginSchema = z.strictObject({
    login: z
        .string()
        .regex(/^[A-Za-z0-9_]{3,30}$/)
        .transform((v) => v.toLowerCase()),
    password: z.string().min(1).max(1024),
    context: z.literal('admin'),
});
export const adminCodeSchema = z.strictObject({
    code: z.string().min(6).max(64),
    method: z.enum(['totp', 'recovery']),
});
type AdminRequest = FastifyRequest & { principal?: Principal };
type SchemaObject = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
function inputSchema(schema: z.ZodType): SchemaObject {
    return z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as SchemaObject;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new BadRequestException();
    return result.data;
}

@Injectable()
export class AdminSessionGuard implements CanActivate {
    constructor(
        private readonly access: AdminAccessService,
        private readonly cookies: AuthCookies,
    ) {}
    async canActivate(context: ExecutionContext) {
        const request = context.switchToHttp().getRequest<AdminRequest>();
        const principal = await this.access.principal(
            request.cookies[this.cookies.name('admin')],
            request.headers['x-admin-unlock'],
        );
        if (principal.context !== 'admin') throw new ForbiddenException();
        request.principal = principal;
        return true;
    }
}

@ApiTags('admin-auth')
@Controller('admin/auth')
export class AdminAuthController {
    constructor(
        private readonly auth: AuthService,
        private readonly cookies: AuthCookies,
        private readonly access: AdminAccessService,
    ) {}

    @Get('csrf')
    @ApiOperation({ summary: 'Isolated admin CSRF cookie and token' })
    csrf(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
        return this.cookies.csrf(request, reply, 'admin_csrf');
    }

    @Post('login')
    @HttpCode(200)
    @ApiBody({ schema: inputSchema(adminLoginSchema) })
    @ApiOperation({ summary: 'Admin password starts MFA; no administrative session before verification' })
    async login(@Body() body: unknown, @Req() request: FastifyRequest) {
        const input = parse(adminLoginSchema, body);
        const result = await this.auth.login(input.login, input.password, 'admin', request.ip, request.id, true);
        if (result.status !== 'mfa_required') throw new Error('Unexpected admin login state');
        return result;
    }

    @Post('mfa/verify')
    @HttpCode(200)
    @ApiBody({ schema: inputSchema(mfaSchema) })
    @ApiOperation({ summary: 'Consume only an admin MFA challenge and issue isolated admin cookie' })
    async verify(
        @Body() body: unknown,
        @Req() request: FastifyRequest,
        @Res({ passthrough: true }) reply: FastifyReply,
    ) {
        const input = parse(mfaSchema, body);
        const result = await this.auth.completeMfa(input.challenge, input.code, input.method, request.id, 'admin');
        this.cookies.set(reply, result.session, 'admin');
        return {
            user: result.session.principal,
            recoveryCodes: result.recoveryCodes,
            unlockToken: result.session.unlockToken,
        };
    }

    @Get('status')
    @ApiCookieAuth('meal_admin')
    status(@Req() request: FastifyRequest) {
        return this.access.status(request.cookies[this.cookies.name('admin')], request.headers['x-admin-unlock']);
    }

    @Post('unlock')
    @HttpCode(200)
    @ApiBody({ schema: inputSchema(adminCodeSchema) })
    unlock(@Body() body: unknown, @Req() request: FastifyRequest) {
        return this.access.verify(
            request.cookies[this.cookies.name('admin')],
            undefined,
            parse(adminCodeSchema, body),
            'unlock',
            request.ip,
            request.id,
        );
    }

    @Post('critical-confirm')
    @HttpCode(200)
    @UseGuards(AdminSessionGuard)
    @ApiBody({ schema: inputSchema(adminCodeSchema) })
    confirm(@Body() body: unknown, @Req() request: FastifyRequest) {
        return this.access.verify(
            request.cookies[this.cookies.name('admin')],
            request.headers['x-admin-unlock'],
            parse(adminCodeSchema, body),
            'critical',
            request.ip,
            request.id,
        );
    }

    @Get('me')
    @UseGuards(AdminSessionGuard)
    @ApiCookieAuth('meal_admin')
    me(@Req() request: AdminRequest) {
        return { user: request.principal };
    }

    @Get('sessions')
    @UseGuards(AdminSessionGuard)
    @ApiCookieAuth('meal_admin')
    sessions(@Req() request: FastifyRequest) {
        return this.auth.listSessions(request.cookies[this.cookies.name('admin')], 'staff');
    }

    @Post('sessions/revoke-others')
    @HttpCode(200)
    @UseGuards(AdminSessionGuard)
    @ApiCookieAuth('meal_admin')
    revokeOthers(@Req() request: FastifyRequest) {
        return this.auth.revokeOtherSessions(request.cookies[this.cookies.name('admin')], 'staff', request.id);
    }

    @Post('logout')
    @HttpCode(200)
    async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
        await this.auth.logout(request.cookies[this.cookies.name('admin')], 'staff', request.id);
        this.cookies.clear(reply, 'admin');
        return { loggedOut: true };
    }
}
