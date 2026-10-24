import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    Get,
    Inject,
    Injectable,
    Post,
    HttpCode,
    Req,
    Res,
    ServiceUnavailableException,
    UseGuards,
    type CanActivate,
    type ExecutionContext,
} from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
type SchemaObject = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
function inputSchema(schema: z.ZodType): SchemaObject {
    // Explicit OpenAPI 3.0 conversion (no JSON Schema boolean schemas); limited to our object DTOs.
    return z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as SchemaObject;
}
import { APP_CONFIG, type AppConfig } from '../../app/config.js';
import { AuthService, type Principal, type SessionResult } from './auth.service.js';
import { equalSecret, keyedHash, newToken } from './crypto.js';

export const loginSchema = z.strictObject({
    email: z
        .email()
        .max(254)
        .transform((v) => v.trim().toLowerCase()),
    password: z.string().min(1).max(1024),
});
export const staffLoginSchema = loginSchema.extend({ context: z.enum(['admin', 'moderator']) });
export const mfaSchema = z.strictObject({
    challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code: z.string().min(6).max(64),
    method: z.enum(['totp', 'recovery']),
});
type AuthRequest = FastifyRequest & { principal?: Principal };
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new BadRequestException();
    return parsed.data;
}

@Injectable()
export class AuthCookies {
    constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}
    name(kind: 'user' | 'staff' | 'admin' | 'csrf' | 'admin_csrf' | 'device') {
        return `${this.config.NODE_ENV === 'production' ? '__Host-' : ''}meal_${kind}`;
    }
    options() {
        return { httpOnly: true, secure: this.config.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/' };
    }
    set(reply: FastifyReply, result: SessionResult, kind: 'user' | 'staff' | 'admin') {
        reply.setCookie(this.name(kind), result.token, {
            ...this.options(),
            expires: new Date(result.principal.expiresAt),
        });
    }
    clear(reply: FastifyReply, kind: 'user' | 'staff' | 'admin' | 'device') {
        reply.clearCookie(this.name(kind), this.options());
    }
    csrf(request: FastifyRequest, reply: FastifyReply, kind: 'csrf' | 'admin_csrf' = 'csrf') {
        if (!this.config.SECURITY_KEY) throw new ServiceUnavailableException();
        let nonce = request.cookies[this.name(kind)];
        if (!nonce || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) {
            nonce = newToken();
            reply.setCookie(this.name(kind), nonce, this.options());
        }
        return { token: keyedHash(this.config.SECURITY_KEY, nonce) };
    }
}
@Injectable()
export class CsrfGuard implements CanActivate {
    constructor(
        @Inject(APP_CONFIG) private readonly config: AppConfig,
        private readonly cookies: AuthCookies,
    ) {}
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<FastifyRequest>();
        const admin = request.routeOptions.url?.startsWith('/api/v1/admin/');
        const origin = admin ? this.config.ADMIN_FRONTEND_ORIGIN : this.config.FRONTEND_ORIGIN;
        if (admin && !origin) throw new ServiceUnavailableException();
        if (admin && request.headers.origin && request.headers.origin !== origin) throw new ForbiddenException();
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
        if (!this.config.SECURITY_KEY) throw new ServiceUnavailableException();
        const nonce = request.cookies[this.cookies.name(admin ? 'admin_csrf' : 'csrf')],
            token = request.headers['x-csrf-token'];
        if (
            request.headers.origin !== origin ||
            request.headers['sec-fetch-site'] === 'cross-site' ||
            !nonce ||
            !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
            typeof token !== 'string' ||
            !equalSecret(keyedHash(this.config.SECURITY_KEY, nonce), token)
        )
            throw new ForbiddenException();
        return true;
    }
}
@Injectable()
export class UserSessionGuard implements CanActivate {
    constructor(
        private readonly auth: AuthService,
        private readonly cookies: AuthCookies,
    ) {}
    async canActivate(context: ExecutionContext) {
        const request = context.switchToHttp().getRequest<AuthRequest>();
        request.principal = await this.auth.principal(request.cookies[this.cookies.name('user')], 'user');
        return true;
    }
}
@Injectable()
export class StaffSessionGuard implements CanActivate {
    constructor(
        private readonly auth: AuthService,
        private readonly cookies: AuthCookies,
    ) {}
    async canActivate(context: ExecutionContext) {
        const request = context.switchToHttp().getRequest<AuthRequest>();
        request.principal = await this.auth.principal(request.cookies[this.cookies.name('staff')], 'staff');
        return true;
    }
}
@ApiTags('auth')
@Controller('auth')
export class AuthController {
    constructor(
        private readonly auth: AuthService,
        private readonly cookies: AuthCookies,
    ) {}
    @Get('csrf')
    @ApiOperation({ summary: 'Return CSRF token; nonce is stored in HttpOnly cookie' })
    csrf(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
        return this.cookies.csrf(request, reply);
    }
    @Post('login')
    @HttpCode(200)
    @ApiBody({ schema: inputSchema(loginSchema) })
    @ApiOperation({ summary: 'Ordinary user login; never grants staff access' })
    async login(
        @Body() body: unknown,
        @Req() request: FastifyRequest,
        @Res({ passthrough: true }) reply: FastifyReply,
    ) {
        const input = parse(loginSchema, body);
        const result = await this.auth.login(input.email, input.password, 'user', request.ip, request.id);
        if (result.status !== 'authenticated') throw new Error('Unexpected login state');
        this.cookies.set(reply, result.session, 'user');
        return { user: result.session.principal };
    }
    @Get('me')
    @UseGuards(UserSessionGuard)
    @ApiCookieAuth('meal_user')
    me(@Req() request: AuthRequest) {
        return { user: request.principal };
    }
    @Get('sessions')
    sessions(@Req() request: FastifyRequest) {
        return this.auth.listSessions(request.cookies[this.cookies.name('user')], 'user');
    }
    @Post('sessions/revoke-others')
    @HttpCode(200)
    revokeOthers(@Req() request: FastifyRequest) {
        return this.auth.revokeOtherSessions(request.cookies[this.cookies.name('user')], 'user', request.id);
    }
    @Post('logout')
    @HttpCode(200)
    async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
        await this.auth.logout(request.cookies[this.cookies.name('user')], 'user', request.id);
        this.cookies.clear(reply, 'user');
        return { loggedOut: true };
    }
}
@ApiTags('staff-auth')
@Controller('staff/auth')
export class StaffAuthController {
    constructor(
        private readonly auth: AuthService,
        private readonly cookies: AuthCookies,
    ) {}
    @Post('login')
    @HttpCode(200)
    @ApiBody({ schema: inputSchema(staffLoginSchema) })
    @ApiOperation({ summary: 'Password starts context-bound MFA challenge; no staff session yet' })
    async login(@Body() body: unknown, @Req() request: FastifyRequest) {
        const input = parse(staffLoginSchema, body);
        const result = await this.auth.login(input.email, input.password, input.context, request.ip, request.id);
        if (result.status !== 'mfa_required') throw new Error('Unexpected staff login state');
        return result;
    }
    @Post('mfa/verify')
    @HttpCode(200)
    @ApiBody({ schema: inputSchema(mfaSchema) })
    @ApiOperation({ summary: 'Atomically consume TOTP/recovery and issue staff cookie' })
    async verify(
        @Body() body: unknown,
        @Req() request: FastifyRequest,
        @Res({ passthrough: true }) reply: FastifyReply,
    ) {
        const input = parse(mfaSchema, body);
        const result = await this.auth.completeMfa(input.challenge, input.code, input.method, request.id);
        this.cookies.set(reply, result.session, 'staff');
        return { user: result.session.principal, recoveryCodes: result.recoveryCodes };
    }
    @Get('me')
    @UseGuards(StaffSessionGuard)
    @ApiCookieAuth('meal_staff')
    me(@Req() request: AuthRequest) {
        return { user: request.principal };
    }
    @Get('sessions')
    sessions(@Req() request: FastifyRequest) {
        return this.auth.listSessions(request.cookies[this.cookies.name('staff')], 'staff');
    }
    @Post('sessions/revoke-others')
    @HttpCode(200)
    revokeOthers(@Req() request: FastifyRequest) {
        return this.auth.revokeOtherSessions(request.cookies[this.cookies.name('staff')], 'staff', request.id);
    }
    @Post('logout')
    @HttpCode(200)
    async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
        await this.auth.logout(request.cookies[this.cookies.name('staff')], 'staff', request.id);
        this.cookies.clear(reply, 'staff');
        return { loggedOut: true };
    }
}
