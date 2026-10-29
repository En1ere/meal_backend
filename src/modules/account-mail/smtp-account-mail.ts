import nodemailer, { type Transporter } from 'nodemailer';
import type { MailWorkerConfig } from './mail-worker.config.js';

export type AccountMailKind = 'verify' | 'reset' | 'email-confirm' | 'email-cancel';
export type SmtpOutcome =
    | { status: 'accepted'; providerReference: string }
    | { status: 'retry_scheduled'; errorCode: string }
    | { status: 'unknown'; errorCode: string }
    | { status: 'failed'; errorCode: string };

const templates: Record<AccountMailKind, { subject: string; path: string; action: string }> = {
    verify: { subject: 'Подтвердите адрес электронной почты', path: '/auth/verify-email', action: 'Подтвердить email' },
    reset: { subject: 'Сброс пароля', path: '/auth/reset-password', action: 'Сбросить пароль' },
    'email-confirm': {
        subject: 'Подтвердите новый адрес',
        path: '/auth/email-change/confirm',
        action: 'Подтвердить адрес',
    },
    'email-cancel': {
        subject: 'Отмена изменения адреса',
        path: '/auth/email-change/cancel',
        action: 'Отменить изменение',
    },
};

function html(value: string) {
    return value.replace(
        /[&<>"']/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
    );
}

export function renderAccountMail(origin: string, kind: AccountMailKind, token: string) {
    const template = templates[kind];
    const url = new URL(template.path, origin);
    url.searchParams.set('token', token);
    const link = url.toString();
    return {
        subject: template.subject,
        text: `${template.action}: ${link}\n\nЕсли вы не запрашивали это действие, проигнорируйте письмо.`,
        html: `<p>${html(template.action)}</p><p><a href="${html(link)}">${html(template.action)}</a></p><p>Если вы не запрашивали это действие, проигнорируйте письмо.</p>`,
    };
}

function safeCode(error: unknown): { code: string; responseCode?: number } {
    if (!error || typeof error !== 'object') return { code: 'SMTP_UNKNOWN' };
    const item = error as { code?: unknown; responseCode?: unknown; command?: unknown };
    const code = typeof item.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(item.code) ? item.code : 'SMTP_ERROR';
    return { code, ...(typeof item.responseCode === 'number' ? { responseCode: item.responseCode } : {}) };
}

export class SmtpAccountMailProvider {
    private readonly transport: Transporter;
    constructor(
        private readonly config: MailWorkerConfig,
        transport?: Transporter,
    ) {
        this.transport =
            transport ??
            nodemailer.createTransport({
                host: config.SMTP_HOST,
                port: config.SMTP_PORT,
                secure: config.SMTP_SECURE,
                requireTLS: config.SMTP_REQUIRE_TLS,
                auth: { user: config.SMTP_USERNAME, pass: config.smtpPassword },
                connectionTimeout: config.SMTP_CONNECTION_TIMEOUT_MS,
                greetingTimeout: config.SMTP_CONNECTION_TIMEOUT_MS,
                socketTimeout: config.SMTP_SOCKET_TIMEOUT_MS,
                tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
            });
    }

    async send(input: {
        recipient: string;
        kind: AccountMailKind;
        token: string;
        messageId: string;
    }): Promise<SmtpOutcome> {
        const content = renderAccountMail(this.config.FRONTEND_ORIGIN, input.kind, input.token);
        try {
            const result = await this.transport.sendMail({
                from: this.config.SMTP_FROM,
                ...(this.config.SMTP_REPLY_TO ? { replyTo: this.config.SMTP_REPLY_TO } : {}),
                to: input.recipient,
                messageId: input.messageId,
                ...content,
            });
            const accepted = Array.isArray(result.accepted) ? result.accepted.length : 0;
            if (accepted < 1) return { status: 'failed', errorCode: 'SMTP_NOT_ACCEPTED' };
            return { status: 'accepted', providerReference: String(result.messageId || input.messageId).slice(0, 500) };
        } catch (error) {
            const safe = safeCode(error);
            if (safe.responseCode && safe.responseCode >= 500)
                return { status: 'failed', errorCode: `SMTP_${safe.responseCode}` };
            if (safe.responseCode && safe.responseCode >= 400)
                return { status: 'retry_scheduled', errorCode: `SMTP_${safe.responseCode}` };
            if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(safe.code))
                return { status: 'retry_scheduled', errorCode: safe.code };
            return { status: 'unknown', errorCode: safe.code };
        }
    }
}
