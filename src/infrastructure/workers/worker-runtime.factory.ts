import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../shared/config/app-config.js';
import { DatabaseService } from '../database/database.service.js';
import {
    executeEmbeddedWorker,
    executeOneShotWorker,
    PostgresWorkerLeaseProvider,
    SanitizedJsonWorkerRuntimeSink,
    type WorkerCounters,
} from '../../modules/operational-runtime/worker-runtime.js';
import type { WorkerTaskId } from '../../modules/operational-runtime/worker-topology.js';
import { AdminWorkerRuntimeSink, FanoutWorkerRuntimeSink } from '../../modules/telemetry/runtime-telemetry.js';

@Injectable()
export class WorkerRuntimeFactory {
    constructor(
        private readonly database: DatabaseService,
        private readonly adminTelemetry: AdminWorkerRuntimeSink,
        @Inject(APP_CONFIG) private readonly config: AppConfig,
    ) {}

    private runtime(ownerPrefix: 'worker' | 'embedded') {
        return {
            ownerId: this.config.WORKER_OWNER_ID ?? `${ownerPrefix}-${process.pid}`,
            leaseProvider: new PostgresWorkerLeaseProvider(this.database.db),
            sink: new FanoutWorkerRuntimeSink([new SanitizedJsonWorkerRuntimeSink(), this.adminTelemetry]),
        };
    }

    oneShot<T>(task: WorkerTaskId, run: () => Promise<T>, counters: (result: T) => WorkerCounters) {
        return executeOneShotWorker({ task, ...this.runtime('worker'), run, counters });
    }

    embedded<T>(task: WorkerTaskId, run: () => Promise<T>, counters: (result: T) => WorkerCounters) {
        return executeEmbeddedWorker({ task, ...this.runtime('embedded'), run, counters });
    }
}
