import { HttpException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { scopedWorkflow, workflowReplay, type WorkflowTx } from '../cooking/workflow.store.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import {
    familyChatMessageSchema,
    familyChatMutationSchema,
    familyChatSchema,
    type chatDraftCommandSchema,
    type chatMessageCreateSchema,
    type chatMessageHideSchema,
    type chatMessageRemoveSchema,
    type chatMessageUpdateSchema,
    type chatPinCommandSchema,
    type chatReactionCommandSchema,
    type chatReadCommandSchema,
    type familyChatQuerySchema,
} from './family-chat.contracts.js';

type Message = z.infer<typeof familyChatMessageSchema>;
type Membership = { familyId: string; joinedAt: string };

@Injectable()
export class FamilyChatService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
    ) {}

    private async membership(tx: WorkflowTx, scope: string, actorId: string): Promise<Membership> {
        const row = (
            await sql<Membership>`select ds.family_id as "familyId",m.joined_at::text as "joinedAt" from meal.data_scopes ds join meal.family_memberships m on m.family_id=ds.family_id and m.user_id=${actorId}::uuid and m.left_at is null where ds.id=${scope}::uuid and ds.kind='family'`.execute(
                tx,
            )
        ).rows[0];
        if (!row) throw new HttpException('Семья не найдена', 404);
        return row;
    }

    private async thread(tx: WorkflowTx, familyId: string, create: boolean) {
        let row = (
            await sql<{
                id: string;
            }>`select id from meal.chat_threads where kind='family' and family_id=${familyId}::uuid`.execute(tx)
        ).rows[0];
        if (!row && create) {
            row = { id: randomUUID() };
            await sql`insert into meal.chat_threads(id,kind,family_id) values(${row.id}::uuid,'family',${familyId}::uuid)`.execute(
                tx,
            );
        }
        return row?.id ?? null;
    }

    private async members(tx: WorkflowTx, familyId: string) {
        return (
            await sql<{
                userId: string;
                displayName: string;
            }>`select m.user_id as "userId",u.display_name as "displayName" from meal.family_memberships m join meal.users u on u.id=m.user_id where m.family_id=${familyId}::uuid and m.left_at is null order by m.stable_order,m.id`.execute(
                tx,
            )
        ).rows;
    }

    private async assertMentions(tx: WorkflowTx, familyId: string, userIds: string[]) {
        if (new Set(userIds).size !== userIds.length) throw new HttpException('Упоминания не должны повторяться', 422);
        const active = await this.members(tx, familyId);
        const allowed = new Set(active.map((member) => member.userId));
        if (userIds.some((id) => !allowed.has(id)))
            throw new HttpException('Можно упоминать только участников семьи', 422);
    }

    private async loadMessages(
        tx: WorkflowTx,
        threadId: string,
        actorId: string,
        joinedAt: string,
        options: { q?: string; before?: string; limit?: number; ids?: string[]; pinnedOnly?: boolean } = {},
    ): Promise<Message[]> {
        const limit = options.limit ?? 50;
        const rows = await sql<{
            id: string;
            body: string;
            sentAt: string;
            editedAt: string | null;
            removedAt: string | null;
            authorId: string;
            authorName: string;
            replyId: string | null;
            replyBody: string | null;
            replyRemovedAt: string | null;
            replyAuthorId: string | null;
            replyAuthorName: string | null;
            pinned: boolean;
            version: number;
        }>`select m.id,m.body,m.sent_at::text as "sentAt",m.edited_at::text as "editedAt",m.removed_for_all_at::text as "removedAt",m.author_id as "authorId",author.display_name as "authorName",reply.id as "replyId",reply.body as "replyBody",reply.removed_for_all_at::text as "replyRemovedAt",reply.author_id as "replyAuthorId",reply_author.display_name as "replyAuthorName",exists(select 1 from meal.chat_pins p where p.message_id=m.id and p.unpinned_at is null) as pinned,m.version::integer from meal.chat_messages m join meal.users author on author.id=m.author_id left join meal.chat_messages reply on reply.id=m.reply_to_id left join meal.users reply_author on reply_author.id=reply.author_id where m.thread_id=${threadId}::uuid and m.sent_at>=${joinedAt}::timestamptz and (${options.before ?? null}::timestamptz is null or m.sent_at<${options.before ?? null}::timestamptz) and (${options.q ?? ''}='' or (m.removed_for_all_at is null and m.body ilike ${`%${options.q ?? ''}%`})) and (${options.ids ?? null}::uuid[] is null or m.id=any(${options.ids ?? null}::uuid[])) and (${options.pinnedOnly ?? false}=false or exists(select 1 from meal.chat_pins p where p.message_id=m.id and p.unpinned_at is null)) and not exists(select 1 from meal.user_hidden_objects h where h.user_id=${actorId}::uuid and h.chat_message_id=m.id) order by m.sent_at desc,m.id desc limit ${limit}`.execute(
            tx,
        );
        if (!rows.rows.length) return [];
        const ids = rows.rows.map((row) => row.id);
        const reactions = await sql<{
            messageId: string;
            reaction: 'like' | 'heart' | 'laugh' | 'surprise';
            userId: string;
        }>`select message_id as "messageId",reaction,user_id as "userId" from meal.chat_reactions where message_id=any(${ids}::uuid[])`.execute(
            tx,
        );
        const mentions = await sql<{
            messageId: string;
            userId: string;
            displayName: string;
        }>`select cm.message_id as "messageId",cm.user_id as "userId",u.display_name as "displayName" from meal.chat_mentions cm join meal.users u on u.id=cm.user_id where cm.message_id=any(${ids}::uuid[])`.execute(
            tx,
        );
        return rows.rows.map((row) => {
            const grouped = new Map<string, { count: number; reactedByMe: boolean }>();
            for (const reaction of reactions.rows.filter((item) => item.messageId === row.id)) {
                const current = grouped.get(reaction.reaction) ?? { count: 0, reactedByMe: false };
                current.count++;
                if (reaction.userId === actorId) current.reactedByMe = true;
                grouped.set(reaction.reaction, current);
            }
            return familyChatMessageSchema.parse({
                id: row.id,
                body: row.removedAt ? '' : row.body,
                author: { userId: row.authorId, displayName: row.authorName },
                sentAt: new Date(row.sentAt).toISOString(),
                editedAt: row.editedAt ? new Date(row.editedAt).toISOString() : null,
                removedForAllAt: row.removedAt ? new Date(row.removedAt).toISOString() : null,
                replyTo:
                    row.replyId && row.replyAuthorId && row.replyAuthorName
                        ? {
                              id: row.replyId,
                              body: row.replyRemovedAt ? '' : (row.replyBody ?? ''),
                              removedForAll: !!row.replyRemovedAt,
                              author: { userId: row.replyAuthorId, displayName: row.replyAuthorName },
                          }
                        : null,
                mentions: mentions.rows
                    .filter((item) => item.messageId === row.id)
                    .map(({ userId, displayName }) => ({ userId, displayName })),
                reactions: [...grouped].map(([reaction, value]) => ({ reaction, ...value })),
                pinned: row.pinned,
                canEdit: row.authorId === actorId && !row.removedAt,
                canRemoveForAll: row.authorId === actorId && !row.removedAt,
                version: row.version,
            });
        });
    }

    private async one(tx: WorkflowTx, threadId: string, actorId: string, joinedAt: string, id: string) {
        const message = (await this.loadMessages(tx, threadId, actorId, joinedAt, { ids: [id], limit: 1 }))[0];
        if (!message) throw new HttpException('Сообщение не найдено', 404);
        return message;
    }

    private async revision(tx: WorkflowTx, messageId: string, body: string, actorId: string) {
        const revision = (
            await sql<{
                value: number;
            }>`select coalesce(max(revision),0)::integer+1 as value from meal.chat_revisions where message_id=${messageId}::uuid`.execute(
                tx,
            )
        ).rows[0]!.value;
        await sql`insert into meal.chat_revisions(id,body,revision,recorded_at,message_id,actor_id) values(${randomUUID()}::uuid,${body},${revision},now(),${messageId}::uuid,${actorId}::uuid)`.execute(
            tx,
        );
    }

    list(userId: string, input: z.infer<typeof familyChatQuerySchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, 'family', false, async (tx, scope) => {
            const membership = await this.membership(tx, scope, userId);
            const threadId = await this.thread(tx, membership.familyId, false);
            const members = await this.members(tx, membership.familyId);
            if (!threadId)
                return familyChatSchema.parse({
                    threadId: null,
                    joinedAt: new Date(membership.joinedAt).toISOString(),
                    items: [],
                    pinned: [],
                    draft: null,
                    members,
                    nextBefore: null,
                });
            const items = await this.loadMessages(tx, threadId, userId, membership.joinedAt, {
                q: input.q,
                limit: input.limit,
                ...(input.before ? { before: input.before } : {}),
            });
            const pinned = await this.loadMessages(tx, threadId, userId, membership.joinedAt, {
                pinnedOnly: true,
                limit: 10,
            });
            const draft = (
                await sql<{
                    body: string;
                    version: number;
                }>`select body,version::integer from meal.chat_drafts where thread_id=${threadId}::uuid and user_id=${userId}::uuid`.execute(
                    tx,
                )
            ).rows[0];
            return familyChatSchema.parse({
                threadId,
                joinedAt: new Date(membership.joinedAt).toISOString(),
                items: items.toReversed(),
                pinned,
                draft: draft ?? null,
                members,
                nextBefore: items.length === input.limit ? (items.at(-1)?.sentAt ?? null) : null,
            });
        });
    }

    send(userId: string, input: z.infer<typeof chatMessageCreateSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, 'family', true, async (tx, scope) =>
            workflowReplay(tx, userId, scope, 'family-chat', 'send', input, async () => {
                const membership = await this.membership(tx, scope, userId);
                await this.assertMentions(tx, membership.familyId, input.mentionUserIds);
                const threadId = (await this.thread(tx, membership.familyId, true))!;
                if (input.replyToId) await this.one(tx, threadId, userId, membership.joinedAt, input.replyToId);
                const id = randomUUID();
                await sql`insert into meal.chat_messages(id,body,sent_at,thread_id,author_id,reply_to_id) values(${id}::uuid,${input.body},now(),${threadId}::uuid,${userId}::uuid,${input.replyToId}::uuid)`.execute(
                    tx,
                );
                for (const mentioned of input.mentionUserIds)
                    await sql`insert into meal.chat_mentions(id,message_id,user_id) values(${randomUUID()}::uuid,${id}::uuid,${mentioned}::uuid)`.execute(
                        tx,
                    );
                await sql`delete from meal.chat_drafts where thread_id=${threadId}::uuid and user_id=${userId}::uuid`.execute(
                    tx,
                );
                await this.revision(tx, id, input.body, userId);
                return familyChatMutationSchema.parse({
                    message: await this.one(tx, threadId, userId, membership.joinedAt, id),
                });
            }),
        );
    }

    edit(userId: string, id: string, input: z.infer<typeof chatMessageUpdateSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, 'family', true, async (tx, scope) =>
            workflowReplay(tx, userId, scope, 'family-chat', `edit:${id}`, input, async () => {
                const membership = await this.membership(tx, scope, userId);
                await this.assertMentions(tx, membership.familyId, input.mentionUserIds);
                const threadId = await this.thread(tx, membership.familyId, false);
                if (!threadId) throw new HttpException('Сообщение не найдено', 404);
                const current = await this.one(tx, threadId, userId, membership.joinedAt, id);
                if (!current.canEdit) throw new HttpException('Редактирование доступно только автору', 403);
                if (current.version !== input.expectedVersion) throw new HttpException('Сообщение изменилось', 412);
                const updated = await sql<{
                    id: string;
                }>`update meal.chat_messages set body=${input.body},edited_at=now(),version=version+1 where id=${id}::uuid and author_id=${userId}::uuid and removed_for_all_at is null and version=${input.expectedVersion} returning id`.execute(
                    tx,
                );
                if (!updated.rows.length) throw new HttpException('Сообщение изменилось', 412);
                await sql`delete from meal.chat_mentions where message_id=${id}::uuid`.execute(tx);
                for (const mentioned of input.mentionUserIds)
                    await sql`insert into meal.chat_mentions(id,message_id,user_id) values(${randomUUID()}::uuid,${id}::uuid,${mentioned}::uuid)`.execute(
                        tx,
                    );
                await this.revision(tx, id, input.body, userId);
                return familyChatMutationSchema.parse({
                    message: await this.one(tx, threadId, userId, membership.joinedAt, id),
                });
            }),
        );
    }

    remove(userId: string, id: string, input: z.infer<typeof chatMessageRemoveSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, 'family', true, async (tx, scope) =>
            workflowReplay(tx, userId, scope, 'family-chat', `remove:${id}`, input, async () => {
                const membership = await this.membership(tx, scope, userId);
                const threadId = await this.thread(tx, membership.familyId, false);
                if (!threadId) throw new HttpException('Сообщение не найдено', 404);
                const current = await this.one(tx, threadId, userId, membership.joinedAt, id);
                if (!current.canRemoveForAll) throw new HttpException('Удаление доступно только автору', 403);
                if (current.version !== input.expectedVersion) throw new HttpException('Сообщение изменилось', 412);
                await sql`update meal.chat_messages set removed_for_all_at=now(),edited_at=null,version=version+1 where id=${id}::uuid and author_id=${userId}::uuid and version=${input.expectedVersion}`.execute(
                    tx,
                );
                await this.revision(tx, id, current.body, userId);
                return familyChatMutationSchema.parse({
                    message: await this.one(tx, threadId, userId, membership.joinedAt, id),
                });
            }),
        );
    }

    hide(userId: string, id: string, input: z.infer<typeof chatMessageHideSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, 'family', true, async (tx, scope) =>
            workflowReplay(tx, userId, scope, 'family-chat', `hide:${id}`, input, async () => {
                const membership = await this.membership(tx, scope, userId);
                const threadId = await this.thread(tx, membership.familyId, false);
                if (!threadId) throw new HttpException('Сообщение не найдено', 404);
                await this.one(tx, threadId, userId, membership.joinedAt, id);
                await sql`insert into meal.user_hidden_objects(id,hidden_at,user_id,chat_message_id) select ${randomUUID()}::uuid,now(),${userId}::uuid,${id}::uuid where not exists(select 1 from meal.user_hidden_objects where user_id=${userId}::uuid and chat_message_id=${id}::uuid)`.execute(
                    tx,
                );
                return familyChatMutationSchema.parse({ message: null });
            }),
        );
    }

    reaction(userId: string, id: string, input: z.infer<typeof chatReactionCommandSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, 'family', true, async (tx, scope) =>
            workflowReplay(tx, userId, scope, 'family-chat', `reaction:${id}:${input.reaction}`, input, async () => {
                const membership = await this.membership(tx, scope, userId);
                const threadId = await this.thread(tx, membership.familyId, false);
                if (!threadId) throw new HttpException('Сообщение не найдено', 404);
                await this.one(tx, threadId, userId, membership.joinedAt, id);
                if (input.active)
                    await sql`insert into meal.chat_reactions(id,reaction,message_id,user_id) select ${randomUUID()}::uuid,${input.reaction},${id}::uuid,${userId}::uuid where not exists(select 1 from meal.chat_reactions where message_id=${id}::uuid and user_id=${userId}::uuid and reaction=${input.reaction})`.execute(
                        tx,
                    );
                else
                    await sql`delete from meal.chat_reactions where message_id=${id}::uuid and user_id=${userId}::uuid and reaction=${input.reaction}`.execute(
                        tx,
                    );
                return familyChatMutationSchema.parse({
                    message: await this.one(tx, threadId, userId, membership.joinedAt, id),
                });
            }),
        );
    }

    pin(userId: string, id: string, input: z.infer<typeof chatPinCommandSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, 'family', true, async (tx, scope) =>
            workflowReplay(tx, userId, scope, 'family-chat', `pin:${id}`, input, async () => {
                const membership = await this.membership(tx, scope, userId);
                const threadId = await this.thread(tx, membership.familyId, false);
                if (!threadId) throw new HttpException('Сообщение не найдено', 404);
                const current = await this.one(tx, threadId, userId, membership.joinedAt, id);
                if (current.removedForAllAt) throw new HttpException('Удалённое сообщение нельзя закрепить', 409);
                if (input.pinned)
                    await sql`insert into meal.chat_pins(id,pinned_at,message_id,actor_id) select ${randomUUID()}::uuid,now(),${id}::uuid,${userId}::uuid where not exists(select 1 from meal.chat_pins where message_id=${id}::uuid and unpinned_at is null)`.execute(
                        tx,
                    );
                else
                    await sql`update meal.chat_pins set unpinned_at=now(),version=version+1 where message_id=${id}::uuid and unpinned_at is null`.execute(
                        tx,
                    );
                return familyChatMutationSchema.parse({
                    message: await this.one(tx, threadId, userId, membership.joinedAt, id),
                });
            }),
        );
    }

    draft(userId: string, input: z.infer<typeof chatDraftCommandSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, 'family', true, async (tx, scope) =>
            workflowReplay(tx, userId, scope, 'family-chat', 'draft', input, async () => {
                const membership = await this.membership(tx, scope, userId);
                const threadId = (await this.thread(tx, membership.familyId, true))!;
                const current = (
                    await sql<{
                        version: number;
                    }>`select version::integer from meal.chat_drafts where thread_id=${threadId}::uuid and user_id=${userId}::uuid for update`.execute(
                        tx,
                    )
                ).rows[0];
                if ((current?.version ?? null) !== input.expectedVersion)
                    throw new HttpException('Черновик изменился', 412);
                if (current)
                    await sql`update meal.chat_drafts set body=${input.body},updated_at=now(),version=version+1 where thread_id=${threadId}::uuid and user_id=${userId}::uuid`.execute(
                        tx,
                    );
                else
                    await sql`insert into meal.chat_drafts(id,body,updated_at,thread_id,user_id) values(${randomUUID()}::uuid,${input.body},now(),${threadId}::uuid,${userId}::uuid)`.execute(
                        tx,
                    );
                const draft = (
                    await sql<{
                        body: string;
                        version: number;
                    }>`select body,version::integer from meal.chat_drafts where thread_id=${threadId}::uuid and user_id=${userId}::uuid`.execute(
                        tx,
                    )
                ).rows[0]!;
                return draft;
            }),
        );
    }

    read(userId: string, input: z.infer<typeof chatReadCommandSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, 'family', true, async (tx, scope) =>
            workflowReplay(tx, userId, scope, 'family-chat', 'read', input, async () => {
                const membership = await this.membership(tx, scope, userId);
                const threadId = await this.thread(tx, membership.familyId, false);
                if (!threadId) throw new HttpException('Сообщение не найдено', 404);
                await this.one(tx, threadId, userId, membership.joinedAt, input.messageId);
                await sql`insert into meal.chat_receipts(id,delivered_at,read_at,message_id,user_id) values(${randomUUID()}::uuid,now(),now(),${input.messageId}::uuid,${userId}::uuid) on conflict(message_id,user_id) do update set delivered_at=coalesce(meal.chat_receipts.delivered_at,excluded.delivered_at),read_at=coalesce(meal.chat_receipts.read_at,excluded.read_at),version=meal.chat_receipts.version+1`.execute(
                    tx,
                );
                return familyChatMutationSchema.parse({
                    message: await this.one(tx, threadId, userId, membership.joinedAt, input.messageId),
                });
            }),
        );
    }
}
