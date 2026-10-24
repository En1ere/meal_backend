import { mkdir, writeFile } from 'node:fs/promises';
import { createApp, openApiDocument } from './app/create-app.js';
import { readConfig } from './app/config.js';

// Export never connects to a database or uses deployment secrets.
const app = await createApp(readConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
try {
    await mkdir('contracts', { recursive: true });
    await writeFile('contracts/openapi.json', JSON.stringify(openApiDocument(app), null, 2) + '\n');
} finally {
    await app.close();
}
