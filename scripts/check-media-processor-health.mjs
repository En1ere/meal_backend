import { readFile } from 'node:fs/promises';
try {
    const value = JSON.parse(await readFile('/run/meal-media-processor/health.json', 'utf8'));
    if (!['ok', 'disabled'].includes(value.state) || Date.now() - Date.parse(value.observedAt) > 90_000)
        process.exit(1);
} catch {
    process.exit(1);
}
