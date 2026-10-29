import {
    Catch,
    HttpException,
    Injectable,
    type ArgumentsHost,
    type ExceptionFilter,
    type CallHandler,
    type ExecutionContext,
    type NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { map, type Observable } from 'rxjs';
import { ZodError } from 'zod';
import {
    AdminLockedException,
    AdminConfirmationRequiredException,
} from '../../modules/admin-auth/admin-access.service.js';
import { TelemetryService } from '../../modules/telemetry/telemetry.service.js';
import { LegalConsentRequiredException } from '../../modules/legal-consents/legal-consent.service.js';

@Injectable()
export class ResponseInterceptor implements NestInterceptor<unknown, unknown> {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const request = context.switchToHttp().getRequest<FastifyRequest>();
        return next.handle().pipe(map((data: unknown) => ({ data, meta: { requestId: request.id } })));
    }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
    constructor(private readonly telemetry: TelemetryService) {}

    catch(exception: unknown, host: ArgumentsHost): void {
        const response = host.switchToHttp().getResponse<FastifyReply>();
        const request = host.switchToHttp().getRequest<FastifyRequest>();
        const frameworkStatus =
            exception instanceof Error &&
            'statusCode' in exception &&
            typeof exception.statusCode === 'number' &&
            Number.isInteger(exception.statusCode) &&
            exception.statusCode >= 400 &&
            exception.statusCode <= 599
                ? exception.statusCode
                : 500;
        const multipartContentTypeError =
            exception instanceof Error &&
            'code' in exception &&
            exception.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE';
        const status =
            exception instanceof ZodError
                ? 400
                : multipartContentTypeError
                  ? 415
                  : exception instanceof HttpException
                    ? exception.getStatus()
                    : frameworkStatus;
        const messages: Record<number, [string, string]> = {
            400: ['INVALID_REQUEST', 'Некорректный запрос'],
            401: ['UNAUTHORIZED', 'Требуется вход или проверка данных'],
            403: ['FORBIDDEN', 'Доступ запрещён'],
            404: ['NOT_FOUND', 'Ресурс не найден'],
            409: ['CONFLICT', 'Состояние изменилось. Обновите данные'],
            408: ['REQUEST_TIMEOUT', 'Обработка заняла слишком много времени'],
            412: ['VERSION_CONFLICT', 'Запись изменена. Сравните с актуальной версией'],
            428: ['VERSION_REQUIRED', 'Укажите версию записи'],
            413: ['PAYLOAD_TOO_LARGE', 'Запрос слишком большой'],
            415: ['UNSUPPORTED_MEDIA_TYPE', 'Неподдерживаемый формат запроса'],
            422: ['UNPROCESSABLE_REQUEST', 'Проверьте выбранные данные и доступное количество'],
            429: ['RATE_LIMITED', 'Слишком много запросов. Попробуйте позже'],
            503: ['UNAVAILABLE', 'Сервис временно недоступен'],
        };
        const [code, message] =
            exception instanceof AdminLockedException
                ? ['ADMIN_LOCKED', 'Подтвердите вход кодом']
                : exception instanceof AdminConfirmationRequiredException
                  ? ['ADMIN_CONFIRMATION_REQUIRED', 'Подтвердите критичное действие кодом']
                  : exception instanceof LegalConsentRequiredException
                    ? [exception.code, 'Функция заблокирована до ознакомления и согласия']
                    : (messages[status] ?? ['INTERNAL_ERROR', 'Внутренняя ошибка сервиса']);
        const details = exception instanceof LegalConsentRequiredException ? exception.details : null;
        if (status >= 500) {
            const failure =
                exception instanceof Error
                    ? {
                          name: exception.name,
                          message: exception.message,
                          stack: exception.stack,
                          code: 'code' in exception ? exception.code : undefined,
                          constraint: 'constraint' in exception ? exception.constraint : undefined,
                      }
                    : exception;
            request.log.error({ failure, requestId: request.id, status }, 'Request failed');
            void this.telemetry.recordOperational('backend.http.unhandled', {
                requestId: request.id,
                severity: status >= 503 ? 'critical' : 'error',
            });
        }
        void response.status(status).send({ error: { code, message, details }, meta: { requestId: request.id } });
    }
}
