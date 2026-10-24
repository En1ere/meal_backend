import { z } from 'zod';
import { recipeSummarySchema } from '../recipes/recipes.contracts.js';

export const communitySortSchema = z.enum(['newest', 'oldest']);
export const communityQuerySchema = z.strictObject({
    q: z.string().trim().max(200).default(''),
    category: z.string().trim().min(1).max(100).optional(),
    author: z.string().trim().min(1).max(256).optional(),
    sort: communitySortSchema.default('newest'),
    cursor: z.string().trim().max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const communityFeedSchema = z.strictObject({
    items: z.array(recipeSummarySchema.extend({ availability: z.null() })),
    nextCursor: z.string().nullable(),
});
export const communityCommentsQuerySchema = z.strictObject({
    cursor: z.string().trim().max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const publicRecipeCommentSchema = z.strictObject({
    id: z.uuid(),
    body: z.string(),
    authorLogin: z.string(),
    createdAt: z.iso.datetime(),
    edited: z.boolean(),
    replyToId: z.uuid().nullable(),
});
export const communityCommentsSchema = z.strictObject({
    items: z.array(publicRecipeCommentSchema),
    nextCursor: z.string().nullable(),
});

export type CommunityQuery = z.infer<typeof communityQuerySchema>;
