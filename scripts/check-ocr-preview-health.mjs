const response = await fetch('http://127.0.0.1:3100/healthz', { signal: AbortSignal.timeout(2_000) });
if (!response.ok) process.exit(1);
const body = await response.json();
if (!body || body.status !== 'ok' || Object.keys(body).length !== 1) process.exit(1);
