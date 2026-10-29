import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Injectable } from '@nestjs/common';
import { hostCollectorSnapshotSchema, type AdminObservability } from './admin-observability.contracts.js';

const MAX_SNAPSHOT_BYTES = 65_536;
const HOST_STALE_AFTER_SECONDS = 150;
const MAX_FUTURE_SKEW_MS = 30_000;
const MAX_MTIME_SKEW_MS = 30_000;

type HostResult = AdminObservability['host'];
type SnapshotMetadata = Readonly<{
    regularFile: boolean;
    uid: number;
    gid: number;
    mode: number;
    size: number;
    mtimeMs: number;
}>;
type DirectoryMetadata = Readonly<{ directory: boolean; uid: number; gid: number; mode: number }>;

export const isSafeSnapshotDirectory = (metadata: DirectoryMetadata) =>
    metadata.directory && metadata.uid === 0 && metadata.gid === 29_002 && (metadata.mode & 0o7777) === 0o2750;

const unavailable = (reason: NonNullable<HostResult['unavailableReason']>): HostResult => ({
    freshness: {
        state: 'unavailable',
        observedAt: null,
        ageSeconds: null,
        staleAfterSeconds: HOST_STALE_AFTER_SECONDS,
    },
    unavailableReason: reason,
    collectorStatus: null,
    durationMs: null,
    memory: null,
    load1mMilli: null,
    uptimeSeconds: null,
    rebootRequired: null,
    filesystems: [],
    containers: [],
});

export function parseHostSnapshot(raw: string, metadata: SnapshotMetadata, now = Date.now()): HostResult {
    if (
        !metadata.regularFile ||
        metadata.uid !== 0 ||
        metadata.gid !== 29_002 ||
        (metadata.mode & 0o7777) !== 0o640 ||
        metadata.size < 1 ||
        metadata.size > MAX_SNAPSHOT_BYTES ||
        Buffer.byteLength(raw) !== metadata.size
    )
        return unavailable('invalid');
    let decoded: unknown;
    try {
        decoded = JSON.parse(raw);
    } catch {
        return unavailable('invalid');
    }
    const parsed = hostCollectorSnapshotSchema.safeParse(decoded);
    if (!parsed.success) return unavailable('invalid');
    const observedAtMs = Date.parse(parsed.data.collectedAt);
    if (observedAtMs > now + MAX_FUTURE_SKEW_MS || metadata.mtimeMs > now + MAX_FUTURE_SKEW_MS)
        return unavailable('clock_skew');
    if (Math.abs(metadata.mtimeMs - observedAtMs) > MAX_MTIME_SKEW_MS) return unavailable('invalid');
    const ageSeconds = Math.min(31_536_000, Math.max(0, Math.floor((now - observedAtMs) / 1_000)));
    return {
        freshness: {
            state: ageSeconds <= HOST_STALE_AFTER_SECONDS ? 'fresh' : 'stale',
            observedAt: parsed.data.collectedAt,
            ageSeconds,
            staleAfterSeconds: HOST_STALE_AFTER_SECONDS,
        },
        unavailableReason: null,
        collectorStatus: parsed.data.collectorStatus,
        durationMs: parsed.data.durationMs,
        memory:
            parsed.data.host.memoryTotalBytes === null || parsed.data.host.memoryAvailableBytes === null
                ? null
                : {
                      totalBytes: parsed.data.host.memoryTotalBytes,
                      availableBytes: parsed.data.host.memoryAvailableBytes,
                  },
        load1mMilli: parsed.data.host.load1mMilli,
        uptimeSeconds: parsed.data.host.uptimeSeconds,
        rebootRequired: parsed.data.host.rebootRequired,
        filesystems: parsed.data.host.filesystems,
        containers: parsed.data.containers,
    };
}

@Injectable()
export class HostSnapshotReader {
    constructor(private readonly file: string | undefined) {}

    async read(now = Date.now()): Promise<HostResult> {
        if (!this.file) return unavailable('disabled');
        let directory: FileHandle;
        try {
            directory = await open(
                dirname(this.file),
                constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
        } catch {
            return unavailable('unreadable');
        }
        try {
            const metadata = await directory.stat();
            if (
                !isSafeSnapshotDirectory({
                    directory: metadata.isDirectory(),
                    uid: metadata.uid,
                    gid: metadata.gid,
                    mode: metadata.mode,
                })
            )
                return unavailable('invalid');
        } catch {
            return unavailable('unreadable');
        } finally {
            await directory.close().catch(() => undefined);
        }
        let handle: FileHandle;
        try {
            handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (error) {
            return unavailable(
                error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'missing' : 'unreadable',
            );
        }
        try {
            const stat = await handle.stat();
            if (stat.size < 1 || stat.size > MAX_SNAPSHOT_BYTES) return unavailable('invalid');
            const raw = await handle.readFile('utf8');
            return parseHostSnapshot(
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
            return unavailable('unreadable');
        } finally {
            await handle.close().catch(() => undefined);
        }
    }
}
