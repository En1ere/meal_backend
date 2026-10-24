import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RouteConfig } from '@nestjs/platform-fastify';
import { z } from 'zod';
import { browserTelemetryInputSchema } from './telemetry.contracts.js';
import { TelemetryService } from './telemetry.service.js';

type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const inputSchema = z.toJSONSchema(browserTelemetryInputSchema, { io: 'input', target: 'openapi-3.0' }) as Schema;

@ApiTags('telemetry')
@Controller()
export class TelemetryController {
    constructor(private readonly telemetry: TelemetryService) {}

    @Post('telemetry/browser')
    @HttpCode(202)
    @RouteConfig({ rateLimit: { max: 20, timeWindow: '1 minute' } })
    @ApiBody({ schema: inputSchema })
    @ApiOperation({ summary: 'Accept a bounded frontend error signal without user or request content' })
    async browser(@Body() body: unknown) {
        await this.telemetry.recordBrowser(body, 'front');
        return { accepted: true as const };
    }

    @Post('admin/telemetry/browser')
    @HttpCode(202)
    @RouteConfig({ rateLimit: { max: 20, timeWindow: '1 minute' } })
    @ApiBody({ schema: inputSchema })
    @ApiOperation({ summary: 'Accept a bounded admin frontend error signal without user or request content' })
    async adminBrowser(@Body() body: unknown) {
        await this.telemetry.recordBrowser(body, 'admin');
        return { accepted: true as const };
    }
}
