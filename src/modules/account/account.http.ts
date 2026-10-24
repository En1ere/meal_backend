import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthCookies } from '../auth/auth.http.js';
import { AccountService } from './account.service.js';
import { accountInputs } from './account.contracts.js';
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body);
    if (!result.success) throw new BadRequestException();
    return result.data;
}
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const input = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', target: 'openapi-3.0' }) as Schema;
@ApiTags('account')
@Controller('auth')
export class AccountController {
    constructor(
        private readonly account: AccountService,
        private readonly cookies: AuthCookies,
    ) {}
    private session(req: FastifyRequest) {
        return req.cookies[this.cookies.name('user')];
    }
    private device(req: FastifyRequest) {
        return req.cookies[this.cookies.name('device')];
    }
    @Post('register')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.register) })
    register(@Body() body: unknown, @Req() req: FastifyRequest) {
        return this.account.register(parse(accountInputs.register, body), req.ip, req.id);
    }
    @Post('register/v2')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.registerV2) })
    registerV2(@Body() body: unknown, @Req() req: FastifyRequest) {
        return this.account.registerV2(parse(accountInputs.registerV2, body), req.ip, req.id);
    }
    @Post('email/verify')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.verify) })
    verify(@Body() body: unknown, @Req() req: FastifyRequest) {
        return this.account.verifyEmail(parse(accountInputs.verify, body).token, req.id);
    }
    @Post('email/resend')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.resend) })
    resend(@Body() body: unknown, @Req() req: FastifyRequest) {
        return this.account.sendMail(parse(accountInputs.resend, body).email, req.ip, 'verify');
    }
    @Post('password/recovery')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.recovery) })
    recovery(@Body() body: unknown, @Req() req: FastifyRequest) {
        return this.account.sendMail(parse(accountInputs.recovery, body).email, req.ip, 'reset');
    }
    @Post('password/reset/check')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.resetCheck) })
    resetCheck(@Body() body: unknown) {
        return this.account.resetCheck(parse(accountInputs.resetCheck, body).token);
    }
    @Post('password/reset')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.reset) })
    async reset(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
        const v = parse(accountInputs.reset, body);
        const result = await this.account.reset(v.token, v.password, req.ip, req.id);
        this.cookies.clear(reply, 'user');
        this.cookies.clear(reply, 'staff');
        this.cookies.clear(reply, 'device');
        return result;
    }
    @Post('password/change')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.passwordChange) })
    async passwordChange(
        @Body() body: unknown,
        @Req() req: FastifyRequest,
        @Res({ passthrough: true }) reply: FastifyReply,
    ) {
        const v = parse(accountInputs.passwordChange, body);
        const result = await this.account.passwordChange(
            this.session(req),
            v.currentPassword,
            v.password,
            req.ip,
            req.id,
        );
        this.cookies.clear(reply, 'user');
        this.cookies.clear(reply, 'staff');
        this.cookies.clear(reply, 'device');
        return result;
    }
    @Post('email/change')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.emailChange) })
    emailChange(@Body() body: unknown, @Req() req: FastifyRequest) {
        const v = parse(accountInputs.emailChange, body);
        return this.account.emailChange(this.session(req), v.email, v.password, req.ip, req.id);
    }
    @Post('email/change/confirm')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.emailConfirm) })
    emailConfirm(@Body() body: unknown, @Req() req: FastifyRequest) {
        return this.account.emailToken(parse(accountInputs.emailConfirm, body).token, false, req.id);
    }
    @Post('email/change/cancel')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.emailCancel) })
    emailCancel(@Body() body: unknown, @Req() req: FastifyRequest) {
        return this.account.emailToken(parse(accountInputs.emailCancel, body).token, true, req.id);
    }
    @Post('totp/login')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.totpLogin) })
    async totpLogin(
        @Body() body: unknown,
        @Req() req: FastifyRequest,
        @Res({ passthrough: true }) reply: FastifyReply,
    ) {
        const v = parse(accountInputs.totpLogin, body);
        const session = await this.account.totpLogin(v.email, v.code, req.ip, req.id);
        this.cookies.set(reply, session, 'user');
        return { user: session.principal };
    }
    @Post('pin/setup')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.pinSetup) })
    async pinSetup(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
        const v = parse(accountInputs.pinSetup, body);
        const device = await this.account.pinSetup(
            this.session(req),
            this.device(req),
            v.password,
            v.pin,
            req.ip,
            req.id,
        );
        reply.setCookie(this.cookies.name('device'), device.token, {
            ...this.cookies.options(),
            expires: device.expiresAt,
        });
        return { enabled: true };
    }
    @Post('pin/login')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.pinLogin) })
    async pinLogin(@Body() body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
        const session = await this.account.pinLogin(
            this.device(req),
            parse(accountInputs.pinLogin, body).pin,
            req.ip,
            req.id,
        );
        this.cookies.set(reply, session, 'user');
        return { user: session.principal };
    }
    @Post('pin/revoke')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.pinRevoke) })
    async pinRevoke(
        @Body() body: unknown,
        @Req() req: FastifyRequest,
        @Res({ passthrough: true }) reply: FastifyReply,
    ) {
        parse(accountInputs.pinRevoke, body);
        const result = await this.account.pinRevoke(this.session(req), this.device(req), req.id);
        this.cookies.clear(reply, 'device');
        return result;
    }
    @Get('security') security(@Req() req: FastifyRequest) {
        return this.account.security(this.session(req), this.device(req));
    }
    @Post('authenticator/setup')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.authenticatorSetup) })
    authenticatorSetup(@Body() body: unknown, @Req() req: FastifyRequest) {
        const v = parse(accountInputs.authenticatorSetup, body);
        return this.account.authenticatorSetup(this.session(req), v.password, v.proof, req.ip, req.id);
    }
    @Post('authenticator/confirm')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.authenticatorConfirm) })
    authenticatorConfirm(@Body() body: unknown, @Req() req: FastifyRequest) {
        const v = parse(accountInputs.authenticatorConfirm, body);
        return this.account.authenticatorConfirm(this.session(req), v.challenge, v.code, req.id);
    }
    @Post('authenticator/recovery-codes')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.recoveryCodes) })
    recoveryCodes(@Body() body: unknown, @Req() req: FastifyRequest) {
        const v = parse(accountInputs.recoveryCodes, body);
        return this.account.recoveryCodes(this.session(req), v.password, v.proof, req.ip, req.id);
    }
}
@ApiTags('development-only')
@Controller('dev')
export class MailboxController {
    constructor(private readonly account: AccountService) {}
    @Post('mailbox')
    @HttpCode(200)
    @ApiBody({ schema: input(accountInputs.mailbox) })
    mailbox(@Body() body: unknown) {
        return this.account.mailbox(parse(accountInputs.mailbox, body).email);
    }
}
