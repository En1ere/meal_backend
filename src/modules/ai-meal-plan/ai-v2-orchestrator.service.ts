import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AiMealPlanBackendService } from './ai-meal-plan-backend.service.js';
import {
    aiV2MealPlanOperationSchema,
    aiV2MealPlanPreviewRequestSchema,
    aiV2MealPlanPreviewSchema,
    aiV2RunRequestSchema,
    type AiV2MealPlanOperation,
    type AiV2MealPlanPreview,
} from './ai-meal-plan.contracts.js';

@Injectable()
export class AiV2OrchestratorService {
    constructor(private readonly mealPlan: AiMealPlanBackendService) {}

    async preview(userId: string, raw: unknown): Promise<AiV2MealPlanPreview> {
        const preview = await this.mealPlan.previewShoppingList(userId, aiV2MealPlanPreviewRequestSchema.parse(raw));
        return aiV2MealPlanPreviewSchema.parse({
            id: preview.id,
            task: preview.task,
            mode: preview.mode,
            route: preview.route,
            cost: preview.cost,
            expiresAt: preview.expiresAt,
            policyVersion: preview.policyVersion,
        });
    }

    async run(userId: string, raw: unknown): Promise<AiV2MealPlanOperation> {
        return this.publicOperation(await this.mealPlan.run(userId, aiV2RunRequestSchema.parse(raw)));
    }

    async operation(userId: string, rawOperationId: string): Promise<AiV2MealPlanOperation> {
        return this.publicOperation(await this.mealPlan.operation(userId, z.uuid().parse(rawOperationId)));
    }

    private publicOperation(operation: Awaited<ReturnType<AiMealPlanBackendService['operation']>>) {
        return aiV2MealPlanOperationSchema.parse({
            item: {
                id: operation.item.id,
                taskId: operation.item.taskId,
                task: operation.item.task,
                mode: operation.item.mode,
                state: operation.item.state,
                result: operation.item.result,
                createdAt: operation.item.createdAt,
                updatedAt: operation.item.updatedAt,
                expiresAt: operation.item.expiresAt,
                version: operation.item.version,
            },
        });
    }
}
