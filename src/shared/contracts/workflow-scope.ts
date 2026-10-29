import { z } from 'zod';

export const workflowScopeSchema = z.enum(['private', 'family']);
export type WorkflowScope = z.infer<typeof workflowScopeSchema>;
