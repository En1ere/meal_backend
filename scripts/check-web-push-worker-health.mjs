import { readFile } from 'node:fs/promises';
try {
    const value = JSON.parse(await readFile('/run/meal-web-push-worker/health.json', 'utf8'));
    if (!['ok', 'degraded'].includes(value.state) || Date.now() - Date.parse(value.observedAt) > 60000) process.exit(1);
} catch {
    process.exit(1);
}
