import { HttpException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { scopedWorkflow, workflowReplay, type WorkflowTx } from '../../shared/workflow/workflow.store.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import {
    familyNoteHistorySchema,
    familyNoteSchema,
    familyNotesSchema,
    type familyNoteArchiveSchema,
    type familyNoteCreateSchema,
    type familyNotesQuerySchema,
    type familyNoteToggleSchema,
    type familyNoteUpdateSchema,
} from './family-notes.contracts.js';

type Note = z.infer<typeof familyNoteSchema>;

@Injectable()
export class FamilyNotesService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
    ) {}

    private async familyId(tx: WorkflowTx, scope: string) {
        const row = (
            await sql<{
                familyId: string;
            }>`select family_id as "familyId" from meal.data_scopes where id=${scope}::uuid and kind='family'`.execute(
                tx,
            )
        ).rows[0];
        if (!row?.familyId) throw new HttpException('Семья не найдена', 404);
        return row.familyId;
    }

    private async load(
        tx: WorkflowTx,
        scope: string,
        actorId: string,
        id?: string,
        filters?: { tab: 'active' | 'archived'; query: string },
    ): Promise<Note[]> {
        const familyId = await this.familyId(tx, scope);
        const normalizedQuery = filters?.query.toLocaleLowerCase('ru-RU') ?? '';
        // Preserve the JavaScript locale-aware result for arbitrary Unicode. SQL prefiltering is exact for the
        // product's printable ASCII/Russian input set; control characters and uncommon scripts fall back to the
        // final in-memory predicate.
        const sqlFilterEnabled = normalizedQuery.length > 0 && /^[\u0020-\u007EА-Яа-яЁё]+$/u.test(filters?.query ?? '');
        const likePattern = `%${normalizedQuery.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        const notes = await sql<{
            id: string;
            title: string | null;
            body: string;
            format: string;
            archivedAt: string | null;
            authorId: string;
            authorName: string;
            createdAt: string;
            version: number;
        }>`select n.id,n.title,n.body,n.format,n.archived_at::text as "archivedAt",n.author_id as "authorId",u.display_name as "authorName",n.created_at::text as "createdAt",n.version::integer
            from meal.family_notes n join meal.users u on u.id=n.author_id
            where n.family_id=${familyId}::uuid
              and (${id ?? null}::uuid is null or n.id=${id ?? null}::uuid)
              and (${filters?.tab ?? null}::text is null
                   or (${filters?.tab ?? null}='archived' and n.archived_at is not null)
                   or (${filters?.tab ?? null}='active' and n.archived_at is null))
              and (${!sqlFilterEnabled} or lower(translate(coalesce(n.title,'')||E'\n'||n.body,
                    'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ','абвгдеёжзийклмнопрстуфхцчшщъыьэюя')) like ${likePattern} escape '\\')
            order by n.created_at desc,n.id`.execute(tx);
        if (!notes.rows.length) return [];
        const ids = notes.rows.map((note) => note.id);
        const items = await sql<{
            id: string;
            noteId: string;
            position: number;
            text: string;
            checked: boolean;
            checkedAt: string | null;
            checkedById: string | null;
            checkedByName: string | null;
            version: number;
        }>`select item.id,item.note_id as "noteId",item.position,item.text,item.checked,item.checked_at::text as "checkedAt",item.checked_by as "checkedById",checker.display_name as "checkedByName",item.version::integer from meal.note_items item left join meal.users checker on checker.id=item.checked_by where item.note_id=any(${ids}::uuid[]) order by item.position,item.id`.execute(
            tx,
        );
        const itemsByNote = new Map<string, typeof items.rows>();
        for (const item of items.rows) {
            const grouped = itemsByNote.get(item.noteId) ?? [];
            grouped.push(item);
            itemsByNote.set(item.noteId, grouped);
        }
        return notes.rows.map((note) =>
            familyNoteSchema.parse({
                id: note.id,
                kind: note.format === 'checklist' ? 'checklist' : 'note',
                title: note.title ?? 'Без названия',
                body: note.body,
                author: { userId: note.authorId, displayName: note.authorName },
                canEdit: note.authorId === actorId,
                archivedAt: note.archivedAt ? new Date(note.archivedAt).toISOString() : null,
                createdAt: new Date(note.createdAt).toISOString(),
                version: note.version,
                items: (itemsByNote.get(note.id) ?? []).map((item) => ({
                    id: item.id,
                    position: item.position,
                    text: item.text,
                    checked: item.checked,
                    checkedAt: item.checkedAt ? new Date(item.checkedAt).toISOString() : null,
                    checkedBy:
                        item.checkedById && item.checkedByName
                            ? { userId: item.checkedById, displayName: item.checkedByName }
                            : null,
                    version: item.version,
                })),
            }),
        );
    }

    private async one(tx: WorkflowTx, scope: string, actorId: string, id: string) {
        const note = (await this.load(tx, scope, actorId, id))[0];
        if (!note) throw new HttpException('Заметка не найдена', 404);
        return note;
    }

    private snapshot(note: Note) {
        return {
            title: note.title,
            body: note.body,
            kind: note.kind,
            archived: note.archivedAt !== null,
            items: note.items.map((item) => ({ id: item.id, text: item.text, checked: item.checked })),
        };
    }

    private async revision(tx: WorkflowTx, note: Note, actorId: string) {
        const revision = (
            await sql<{
                value: number;
            }>`select coalesce(max(revision),0)::integer+1 as value from meal.note_revisions where note_id=${note.id}::uuid`.execute(
                tx,
            )
        ).rows[0]!.value;
        await sql`insert into meal.note_revisions(id,revision,content_snapshot,recorded_at,note_id,actor_id) values(${randomUUID()}::uuid,${revision},${JSON.stringify(this.snapshot(note))}::jsonb,now(),${note.id}::uuid,${actorId}::uuid)`.execute(
            tx,
        );
    }

    private async audit(tx: WorkflowTx, actorId: string, scope: string, requestId: string, note: Note, action: string) {
        await sql`insert into meal.audit_events(id,action,target_type,target_id,effective_at,recorded_at,after_redacted,request_id,actor_id,scope_id) values(${randomUUID()}::uuid,${action},'family_note',${note.id}::uuid,now(),now(),${JSON.stringify({ kind: note.kind, version: note.version, archived: note.archivedAt !== null, itemCount: note.items.length })}::jsonb,${requestId}::uuid,${actorId}::uuid,${scope}::uuid)`.execute(
            tx,
        );
    }

    list(userId: string, input: z.infer<typeof familyNotesQuerySchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, 'family', false, async (tx, scope) => {
            const notes = await this.load(tx, scope, userId, undefined, { tab: input.tab, query: input.q });
            const query = input.q.toLocaleLowerCase('ru-RU');
            return familyNotesSchema.parse({
                items: notes.filter(
                    (note) =>
                        (input.tab === 'archived' ? note.archivedAt !== null : note.archivedAt === null) &&
                        (!query ||
                            note.title.toLocaleLowerCase('ru-RU').includes(query) ||
                            note.body.toLocaleLowerCase('ru-RU').includes(query)),
                ),
            });
        });
    }

    detail(userId: string, id: string) {
        return scopedWorkflow(this.database, this.entitlements, userId, 'family', false, (tx, scope) =>
            this.one(tx, scope, userId, id),
        );
    }

    history(userId: string, id: string) {
        return scopedWorkflow(this.database, this.entitlements, userId, 'family', false, async (tx, scope) => {
            await this.one(tx, scope, userId, id);
            const rows = await sql<{
                id: string;
                revision: number;
                snapshot: unknown;
                actorId: string;
                actorName: string;
                recordedAt: string;
            }>`select r.id,r.revision,r.content_snapshot as snapshot,r.actor_id as "actorId",u.display_name as "actorName",r.recorded_at::text as "recordedAt" from meal.note_revisions r join meal.users u on u.id=r.actor_id where r.note_id=${id}::uuid order by r.revision desc`.execute(
                tx,
            );
            return familyNoteHistorySchema.parse({
                items: rows.rows.map((row) => ({
                    id: row.id,
                    revision: row.revision,
                    actor: { userId: row.actorId, displayName: row.actorName },
                    recordedAt: new Date(row.recordedAt).toISOString(),
                    snapshot: row.snapshot,
                })),
            });
        });
    }

    create(userId: string, input: z.infer<typeof familyNoteCreateSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, 'family', true, async (tx, scope) =>
            workflowReplay(tx, userId, scope, 'family-note', 'create', input, async () => {
                const familyId = await this.familyId(tx, scope);
                const id = randomUUID();
                await sql`insert into meal.family_notes(id,title,body,format,family_id,author_id) values(${id}::uuid,${input.title},${input.body},${input.kind === 'checklist' ? 'checklist' : 'plain'},${familyId}::uuid,${userId}::uuid)`.execute(
                    tx,
                );
                for (const [position, item] of input.items.entries())
                    await sql`insert into meal.note_items(id,position,text,checked,note_id) values(${item.id ?? randomUUID()}::uuid,${position},${item.text},false,${id}::uuid)`.execute(
                        tx,
                    );
                const note = await this.one(tx, scope, userId, id);
                await this.revision(tx, note, userId);
                await this.audit(tx, userId, scope, input.idempotencyKey, note, 'family-note.created');
                return note;
            }),
        );
    }

    update(userId: string, id: string, input: z.infer<typeof familyNoteUpdateSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, 'family', true, async (tx, scope) =>
            workflowReplay(tx, userId, scope, 'family-note', `update:${id}`, input, async () => {
                const current = await this.one(tx, scope, userId, id);
                if (!current.canEdit) throw new HttpException('Редактирование доступно только автору', 403);
                if (current.version !== input.expectedVersion) throw new HttpException('Заметка изменилась', 412);
                const updated = await sql<{
                    id: string;
                }>`update meal.family_notes set title=${input.title},body=${input.body},format=${input.kind === 'checklist' ? 'checklist' : 'plain'},version=version+1 where id=${id}::uuid and author_id=${userId}::uuid and version=${input.expectedVersion} returning id`.execute(
                    tx,
                );
                if (!updated.rows.length) throw new HttpException('Заметка изменилась', 412);
                const retained = new Set(input.items.flatMap((item) => (item.id ? [item.id] : [])));
                for (const item of input.items) {
                    if (item.id) {
                        if (!current.items.some((candidate) => candidate.id === item.id))
                            throw new HttpException('Пункт списка не найден', 422);
                        await sql`update meal.note_items set text=${item.text},position=${input.items.indexOf(item)},version=version+1 where id=${item.id}::uuid and note_id=${id}::uuid`.execute(
                            tx,
                        );
                    } else
                        await sql`insert into meal.note_items(id,position,text,checked,note_id) values(${randomUUID()}::uuid,${input.items.indexOf(item)},${item.text},false,${id}::uuid)`.execute(
                            tx,
                        );
                }
                const removed = current.items.filter((item) => !retained.has(item.id)).map((item) => item.id);
                if (removed.length)
                    await sql`delete from meal.note_items where note_id=${id}::uuid and id=any(${removed}::uuid[])`.execute(
                        tx,
                    );
                const note = await this.one(tx, scope, userId, id);
                await this.revision(tx, note, userId);
                await this.audit(tx, userId, scope, input.idempotencyKey, note, 'family-note.updated');
                return note;
            }),
        );
    }

    archive(userId: string, id: string, input: z.infer<typeof familyNoteArchiveSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, 'family', true, async (tx, scope) =>
            workflowReplay(tx, userId, scope, 'family-note', `archive:${id}`, input, async () => {
                const current = await this.one(tx, scope, userId, id);
                if (!current.canEdit) throw new HttpException('Архив доступен только автору', 403);
                if (current.version !== input.expectedVersion) throw new HttpException('Заметка изменилась', 412);
                await sql`update meal.family_notes set archived_at=${input.archived ? sql`now()` : null},version=version+1 where id=${id}::uuid and author_id=${userId}::uuid and version=${input.expectedVersion}`.execute(
                    tx,
                );
                const note = await this.one(tx, scope, userId, id);
                await this.revision(tx, note, userId);
                await this.audit(
                    tx,
                    userId,
                    scope,
                    input.idempotencyKey,
                    note,
                    input.archived ? 'family-note.archived' : 'family-note.restored',
                );
                return note;
            }),
        );
    }

    toggle(userId: string, id: string, itemId: string, input: z.infer<typeof familyNoteToggleSchema>) {
        return scopedWorkflow(this.database, this.entitlements, userId, 'family', true, async (tx, scope) =>
            workflowReplay(tx, userId, scope, 'family-note', `toggle:${id}:${itemId}`, input, async () => {
                const current = await this.one(tx, scope, userId, id);
                if (current.archivedAt) throw new HttpException('Архивный список доступен только для чтения', 409);
                if (current.kind !== 'checklist') throw new HttpException('Это не чек-лист', 422);
                if (current.version !== input.expectedNoteVersion) throw new HttpException('Заметка изменилась', 412);
                const item = current.items.find((candidate) => candidate.id === itemId);
                if (!item) throw new HttpException('Пункт списка не найден', 404);
                if (item.version !== input.expectedItemVersion) throw new HttpException('Пункт списка изменился', 412);
                const noteUpdate = await sql<{
                    id: string;
                }>`update meal.family_notes set version=version+1 where id=${id}::uuid and version=${input.expectedNoteVersion} returning id`.execute(
                    tx,
                );
                const itemUpdate = await sql<{
                    id: string;
                }>`update meal.note_items set checked=${input.checked},checked_at=${input.checked ? sql`now()` : null},checked_by=${input.checked ? sql`${userId}::uuid` : null},version=version+1 where id=${itemId}::uuid and note_id=${id}::uuid and version=${input.expectedItemVersion} returning id`.execute(
                    tx,
                );
                if (!noteUpdate.rows.length || !itemUpdate.rows.length)
                    throw new HttpException('Список изменился', 412);
                const note = await this.one(tx, scope, userId, id);
                await this.revision(tx, note, userId);
                await this.audit(tx, userId, scope, input.idempotencyKey, note, 'family-note.item-toggled');
                return note;
            }),
        );
    }
}
