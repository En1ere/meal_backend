import { createApp } from './app/create-app.js';
import { readConfig } from './app/config.js';
import { TelemetryService } from './modules/telemetry/telemetry.service.js';

let app: Awaited<ReturnType<typeof createApp>> | undefined;
try {
    const config = readConfig(process.env);
    app = await createApp(config);
    await app.listen(config.PORT, config.HOST);
} catch {
    if (app) {
        await app.get(TelemetryService).recordOperational('backend.startup.failed');
        await app.close().catch(() => undefined);
    }
    console.error('Backend startup failed. Check configuration and local service availability.');
    process.exitCode = 1;
}
