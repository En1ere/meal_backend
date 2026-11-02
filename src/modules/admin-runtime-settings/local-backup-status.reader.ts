import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

const MAX_STATUS_BYTES = 16_384;
const MAX_FUTURE_SKEW_MS = 30_000;
const MAX_MTIME_SKEW_MS = 30_000;

export const localBackupStatusSchema = z.strictObject({
    schemaVersion: z.literal(1),
    state: z.enum(['ok', 'failed']),
    observedAt: z.iso.datetime(),
    lastAttemptAt: z.iso.datetime(),
    lastSuccessAt: z.iso.datetime().nullable(),
    snapshotId: z
        .string()
        .regex(/^[a-f0-9]{8,64}$/)
        .nullable(),
    snapshotAt: z.iso.datetime().nullable(),
    repositoryBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    artifactCount: z.number().int().min(0).max(64),
    recoveryKeyConfigured: z.boolean(),
    schedule: z.strictObject({ timezone: z.literal('Asia/Yekaterinburg'), localTime: z.literal('01:00') }),
    retention: z.strictObject({ daily: z.literal(7), weekly: z.literal(4) }),
    policy: z.strictObject({
        rpoSeconds: z.literal(86_400),
        rtoSeconds: z.literal(14_400),
        offsite: z.literal(false),
    }),
    restoreDrill: z.strictObject({
        outcome: z.enum(['passed', 'failed', 'unknown', 'not_run']),
        observedAt: z.iso.datetime().nullable(),
        measuredRestoreSeconds: z.number().int().min(0).max(86_400).nullable(),
    }),
    failureCode: z
        .enum([
            'disk_guard',
            'postgres_unavailable',
            'media_unsafe',
            'snapshot_failed',
            'verification_failed',
            'restore_failed',
            'runtime_failed',
        ])
        .nullable(),
});

export type LocalBackupStatus = z.infer<typeof localBackupStatusSchema>;
type Metadata = Readonly<{
    regularFile: boolean;
    uid: number;
    gid: number;
    mode: number;
    size: number;
    mtimeMs: number;
}>;
type DirectoryMetadata = Readonly<{ directory: boolean; uid: number; gid: number; mode: number }>;
export type LocalBackupStatusResult =
    | Readonly<{ availability: 'available'; data: LocalBackupStatus; ageSeconds: number }>
    | Readonly<{
          availability: 'unavailable';
          reason: 'disabled' | 'missing' | 'unreadable' | 'invalid' | 'clock_skew';
      }>;

export const isSafeLocalBackupDirectory = (metadata: DirectoryMetadata) =>
    metadata.directory && metadata.uid === 0 && metadata.gid === 29_002 && (metadata.mode & 0o7777) === 0o2750;

export function parseLocalBackupStatus(raw: string, metadata: Metadata, now = Date.now()): LocalBackupStatusResult {
    if (
        !metadata.regularFile ||
        metadata.uid !== 0 ||
        metadata.gid !== 29_002 ||
        (metadata.mode & 0o7777) !== 0o640 ||
        metadata.size < 1 ||
        metadata.size > MAX_STATUS_BYTES ||
        Buffer.byteLength(raw) !== metadata.size
    )
        return { availability: 'unavailable', reason: 'invalid' };
    let decoded: unknown;
    try {
        decoded = JSON.parse(raw);
    } catch {
        return { availability: 'unavailable', reason: 'invalid' };
    }
    const parsed = localBackupStatusSchema.safeParse(decoded);
    if (!parsed.success) return { availability: 'unavailable', reason: 'invalid' };
    const observedAt = Date.parse(parsed.data.observedAt);
    if (observedAt > now + MAX_FUTURE_SKEW_MS || metadata.mtimeMs > now + MAX_FUTURE_SKEW_MS)
        return { availability: 'unavailable', reason: 'clock_skew' };
    if (Math.abs(metadata.mtimeMs - observedAt) > MAX_MTIME_SKEW_MS)
        return { availability: 'unavailable', reason: 'invalid' };
    return {
        availability: 'available',
        data: parsed.data,
        ageSeconds: Math.min(31_536_000, Math.max(0, Math.floor((now - observedAt) / 1_000))),
    };
}

@Injectable()
export class LocalBackupStatusReader {
    constructor(private readonly file: string | undefined) {}

    async read(now = Date.now()): Promise<LocalBackupStatusResult> {
        if (!this.file) return { availability: 'unavailable', reason: 'disabled' };
        let directory: FileHandle;
        try {
            directory = await open(
                dirname(this.file),
                constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
        } catch {
            return { availability: 'unavailable', reason: 'unreadable' };
        }
        try {
            const metadata = await directory.stat();
            if (
                !isSafeLocalBackupDirectory({
                    directory: metadata.isDirectory(),
                    uid: metadata.uid,
                    gid: metadata.gid,
                    mode: metadata.mode,
                })
            )
                return { availability: 'unavailable', reason: 'invalid' };
        } catch {
            return { availability: 'unavailable', reason: 'unreadable' };
        } finally {
            await directory.close().catch(() => undefined);
        }
        let handle: FileHandle;
        try {
            handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (error) {
            return {
                availability: 'unavailable',
                reason: error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'missing' : 'unreadable',
            };
        }
        try {
            const stat = await handle.stat();
            if (stat.size < 1 || stat.size > MAX_STATUS_BYTES)
                return { availability: 'unavailable', reason: 'invalid' };
            const raw = await handle.readFile('utf8');
            return parseLocalBackupStatus(
                raw,
                {
                    regularFile: stat.isFile(),
                    uid: stat.uid,
                    gid: stat.gid,
                    mode: stat.mode,
                    size: stat.size,
                    mtimeMs: stat.mtimeMs,
                },
                now,
            );
        } catch {
            return { availability: 'unavailable', reason: 'unreadable' };
        } finally {
            await handle.close().catch(() => undefined);
        }
    }
}
