import { readFile } from 'node:fs/promises';
try {
    const value = JSON.parse(await readFile('/run/meal-mail-worker/health.json', 'utf8'));
    if (value.state !== 'ok' || Date.now() - Date.parse(value.observedAt) > 90000) process.exit(1);
} catch {
    process.exit(1);
}
