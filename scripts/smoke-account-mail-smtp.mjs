import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';
import { renderAccountMail } from '../dist/src/modules/account-mail/smtp-account-mail.js';

const host = process.env.SMTP_SINK_HOST ?? '127.0.0.1';
const port = Number(process.env.SMTP_SINK_PORT ?? '1025');
const recipient = process.env.SMTP_SINK_RECIPIENT ?? 'acceptance@example.test';
if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('SMTP sink smoke is loopback-only');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SMTP_SINK_PORT');
const transport = nodemailer.createTransport({
    host,
    port,
    secure: false,
    ignoreTLS: true,
    connectionTimeout: 3000,
    socketTimeout: 5000,
});
for (const kind of ['verify', 'reset', 'email-confirm', 'email-cancel']) {
    const id = randomUUID();
    await transport.sendMail({
        from: 'acceptance@example.test',
        to: recipient,
        messageId: `<${id}@transactional.meal-planner.invalid>`,
        ...renderAccountMail('https://meal.example.test', kind, `acceptance-${kind}`),
    });
}
transport.close();
console.log('Account mail local SMTP sink acceptance: 4 messages accepted');
