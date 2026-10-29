import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config.js';
import { ApiExceptionFilter, ResponseInterceptor } from '../shared/http/response.js';
import { documentResponses } from '../shared/http/openapi-responses.js';
import { TelemetryService } from '../modules/telemetry/telemetry.service.js';

export async function createApp(config: AppConfig) {
    const adapter = new FastifyAdapter({
        bodyLimit: 65536,
        requestTimeout: 15000,
        trustProxy: config.TRUSTED_PROXY_CIDRS.length ? config.TRUSTED_PROXY_CIDRS : false,
        genReqId: () => randomUUID(),
        logger: {
            level: config.LOG_LEVEL,
            serializers: {
                req: (request: { method: string }) => ({
                    method: request.method,
                }),
                err: () => ({ type: 'Error', message: 'Internal error; see request status and request ID', stack: '' }),
            },
        },
    });
    const app = await NestFactory.create<NestFastifyApplication>(AppModule.configure(config), adapter, {
        logger: false,
    });
    await app.register(cookie);
    await app.register(multipart, { limits: { fileSize: 10485760, files: 3, fields: 0, parts: 3 } });
    await app.register(helmet);
    await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
    adapter.getInstance().addHook('onRoute', (route) => {
        if (route.method === 'POST' && route.url === '/api/v1/inventory/import/commit') route.bodyLimit = 8388608;
        if (
            route.method === 'POST' &&
            (route.url === '/api/v1/telemetry/browser' || route.url === '/api/v1/admin/telemetry/browser')
        )
            route.bodyLimit = 1024;
    });
    app.enableCors({
        origin: [config.FRONTEND_ORIGIN, ...(config.ADMIN_FRONTEND_ORIGIN ? [config.ADMIN_FRONTEND_ORIGIN] : [])],
        credentials: true,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'X-Csrf-Token', 'X-Admin-Unlock', 'If-Match'],
        exposedHeaders: ['X-Request-Id'],
    });
    adapter.getInstance().addHook('onRequest', (request, reply, done) => {
        reply.header('X-Request-Id', request.id);
        reply.header('Cache-Control', 'no-store');
        done();
    });
    app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready'] });
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new ApiExceptionFilter(app.get(TelemetryService)));
    app.enableShutdownHooks();
    await app.init();
    await adapter.getInstance().ready();
    return app;
}

export function openApiDocument(app: NestFastifyApplication) {
    return documentResponses(
        SwaggerModule.createDocument(
            app,
            new DocumentBuilder()
                .setTitle('Meal Planner API')
                .setDescription(
                    'Backend-owned auth/account/privacy/legal-consent/export/profile/admin/inventory/products/recipes/preserves/shopping/receipts/meal-plan/support/AI and simulated paid Plus/Pro lifecycle including promotion, renewal, downgrade and family combination; private diary, finance, nutrition analytics and Pro export contract; database schema v30; external providers and approved legal evidence pending',
                )
                .setVersion('0.0.61')
                .addCookieAuth('meal_user', { type: 'apiKey' }, 'meal_user')
                .addCookieAuth('meal_staff', { type: 'apiKey' }, 'meal_staff')
                .addCookieAuth('meal_admin', { type: 'apiKey' }, 'meal_admin')
                .build(),
        ),
    );
}
