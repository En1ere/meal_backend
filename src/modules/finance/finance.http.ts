import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UserSessionGuard } from '../auth/auth.http.js';
import type { Principal } from '../auth/auth.service.js';
import { requireVersion } from '../inventory/inventory.domain.js';
import {
    financeBudgetCreateSchema,
    financeBudgetUpdateSchema,
    financeCategorySchema,
    financeExpenseCreateSchema,
    financeExpenseUpdateSchema,
} from './finance.contracts.js';
import { FinanceService } from './finance.service.js';

type Request = FastifyRequest & { principal: Principal };
type Schema = Extract<NonNullable<Parameters<typeof ApiBody>[0]>, { schema: unknown }>['schema'];
const schema = (value: z.ZodType): Schema => z.toJSONSchema(value, { io: 'input', target: 'openapi-3.0' }) as Schema;
const periodQuery = z.strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
    category: financeCategorySchema.optional(),
});

@ApiTags('finance')
@ApiCookieAuth('meal_user')
@UseGuards(UserSessionGuard)
@Controller('finance')
export class FinanceController {
    constructor(private readonly finance: FinanceService) {}

    @Get('overview')
    @ApiQuery({ name: 'from', required: true, schema: { type: 'string', format: 'date' } })
    @ApiQuery({ name: 'to', required: true, schema: { type: 'string', format: 'date' } })
    overview(@Req() request: Request, @Query() query: unknown) {
        const input = periodQuery.omit({ category: true }).parse(query);
        return this.finance.overview(request.principal.id, input.from, input.to);
    }

    @Get('analytics')
    @ApiQuery({ name: 'from', required: true, schema: { type: 'string', format: 'date' } })
    @ApiQuery({ name: 'to', required: true, schema: { type: 'string', format: 'date' } })
    @ApiQuery({ name: 'category', required: false, schema: { type: 'string' } })
    analytics(@Req() request: Request, @Query() query: unknown) {
        const input = periodQuery.parse(query);
        return this.finance.analytics(request.principal.id, input.from, input.to, input.category ?? null);
    }

    @Get('expenses')
    @ApiQuery({ name: 'from', required: true, schema: { type: 'string', format: 'date' } })
    @ApiQuery({ name: 'to', required: true, schema: { type: 'string', format: 'date' } })
    @ApiQuery({ name: 'category', required: false, schema: { type: 'string' } })
    expenses(@Req() request: Request, @Query() query: unknown) {
        const input = periodQuery.parse(query);
        return this.finance.expenses(request.principal.id, input.from, input.to, input.category ?? null);
    }

    @Post('expenses')
    @HttpCode(200)
    @ApiBody({ schema: schema(financeExpenseCreateSchema) })
    createExpense(@Req() request: Request, @Body() body: unknown) {
        return this.finance.createExpense(request.principal.id, financeExpenseCreateSchema.parse(body));
    }

    @Get('expenses/:id')
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    expense(@Req() request: Request, @Param('id') id: string) {
        return this.finance.expense(request.principal.id, z.uuid().parse(id));
    }

    @Put('expenses/:id')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiHeader({ name: 'If-Match', required: true, schema: { type: 'string' } })
    @ApiBody({ schema: schema(financeExpenseUpdateSchema) })
    updateExpense(
        @Req() request: Request,
        @Param('id') id: string,
        @Body() body: unknown,
        @Headers('if-match') version: string | undefined,
    ) {
        const input = financeExpenseUpdateSchema.parse(body);
        requireVersion(version, input.expectedVersion);
        return this.finance.updateExpense(request.principal.id, z.uuid().parse(id), input);
    }

    @Get('budgets')
    budgets(@Req() request: Request) {
        return this.finance.budgets(request.principal.id);
    }

    @Post('budgets')
    @HttpCode(200)
    @ApiBody({ schema: schema(financeBudgetCreateSchema) })
    createBudget(@Req() request: Request, @Body() body: unknown) {
        return this.finance.createBudget(request.principal.id, financeBudgetCreateSchema.parse(body));
    }

    @Put('budgets/:id')
    @HttpCode(200)
    @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
    @ApiHeader({ name: 'If-Match', required: true, schema: { type: 'string' } })
    @ApiBody({ schema: schema(financeBudgetUpdateSchema) })
    updateBudget(
        @Req() request: Request,
        @Param('id') id: string,
        @Body() body: unknown,
        @Headers('if-match') version: string | undefined,
    ) {
        const input = financeBudgetUpdateSchema.parse(body);
        requireVersion(version, input.expectedVersion);
        return this.finance.updateBudget(request.principal.id, z.uuid().parse(id), input);
    }
}
