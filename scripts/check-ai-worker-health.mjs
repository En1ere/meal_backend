import { readFile } from 'node:fs/promises';

const value = JSON.parse(await readFile('/run/meal-ai-worker/health.json', 'utf8'));
const observedAt = Date.parse(value.observedAt);
if (!['ok', 'degraded'].includes(value.state) || !Number.isFinite(observedAt) || Date.now() - observedAt > 60_000)
    process.exit(1);
