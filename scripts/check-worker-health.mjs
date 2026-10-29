import fs from 'node:fs';
import process from 'node:process';

const file = process.argv[2] ?? '/run/meal-worker/health.json';
const maximumAgeSeconds = Number(process.argv[3] ?? '60');
try {
    if (!Number.isInteger(maximumAgeSeconds) || maximumAgeSeconds < 10 || maximumAgeSeconds > 300) throw new Error();
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 20 || stat.size > 65_536) throw new Error();
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const age = Date.now() - Date.parse(state.heartbeatAt);
    if (
        state.version !== 1 ||
        !['idle', 'running'].includes(state.status) ||
        age < 0 ||
        age > maximumAgeSeconds * 1_000
    )
        throw new Error();
    process.exitCode = 0;
} catch {
    process.exitCode = 1;
}
