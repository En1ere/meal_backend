import { ServiceUnavailableException } from '@nestjs/common';

export type MediaStorageCapacitySnapshot = Readonly<{
    freeBytes: number;
    totalBytes: number;
}>;

export interface MediaStorageCapacityProbe {
    snapshot(): Promise<MediaStorageCapacitySnapshot>;
}

export type MediaStorageCapacityPolicy = Readonly<{
    minimumFreeBytes: number;
    minimumFreeRatio: number;
}>;

function assertSafeByteCount(value: number, field: string) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
}

export class MediaStorageCapacityGuard {
    constructor(
        private readonly probe: MediaStorageCapacityProbe,
        private readonly policy: MediaStorageCapacityPolicy,
    ) {
        assertSafeByteCount(policy.minimumFreeBytes, 'minimumFreeBytes');
        if (!Number.isFinite(policy.minimumFreeRatio) || policy.minimumFreeRatio < 0 || policy.minimumFreeRatio > 1)
            throw new TypeError('minimumFreeRatio must be between 0 and 1');
    }

    async assertWritable(expectedBytes: number): Promise<MediaStorageCapacitySnapshot> {
        assertSafeByteCount(expectedBytes, 'expectedBytes');
        let snapshot: MediaStorageCapacitySnapshot;
        try {
            snapshot = await this.probe.snapshot();
        } catch {
            throw new ServiceUnavailableException('Media storage capacity is unavailable');
        }
        assertSafeByteCount(snapshot.freeBytes, 'freeBytes');
        assertSafeByteCount(snapshot.totalBytes, 'totalBytes');
        if (snapshot.totalBytes === 0 || snapshot.freeBytes > snapshot.totalBytes)
            throw new ServiceUnavailableException('Media storage capacity is invalid');

        const projectedFreeBytes = snapshot.freeBytes - expectedBytes;
        const projectedFreeRatio = projectedFreeBytes / snapshot.totalBytes;
        if (
            projectedFreeBytes < 0 ||
            projectedFreeBytes < this.policy.minimumFreeBytes ||
            projectedFreeRatio < this.policy.minimumFreeRatio
        )
            throw new ServiceUnavailableException('Media storage capacity guard rejected the write');
        return snapshot;
    }
}
