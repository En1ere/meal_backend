import { spawn } from 'node:child_process';

export type ImageCdrChildResult = Readonly<{
    mimeType: 'image/jpeg' | 'image/png';
    width: number;
    height: number;
    checksum: `sha256:${string}`;
    policyVersion: 'image-cdr-v1';
    safetyEvidence: 'cdr_reencoded';
}>;

export class ImageCdrChildError extends Error {
    constructor(public readonly code: 'timeout' | 'failed' | 'invalid_result') {
        super(`image_cdr_child_${code}`);
    }
}

export function runImageCdrChild(
    options: Readonly<{
        scriptPath: string;
        inputPath: string;
        outputPath: string;
        declaredMime: string;
        timeoutMs: number;
        killGraceMs: number;
    }>,
): Promise<ImageCdrChildResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [options.scriptPath, options.inputPath, options.outputPath, options.declaredMime],
            {
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { NODE_ENV: 'production', VIPS_CONCURRENCY: '1', MALLOC_ARENA_MAX: '2' },
            },
        );
        let stdout = '';
        let stderrBytes = 0;
        let timedOut = false;
        let settled = false;
        const finish = (error: Error | null, value?: ImageCdrChildResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            clearTimeout(kill);
            if (error) reject(error);
            else resolve(value!);
        };
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            if (stdout.length <= 8_192) stdout += chunk.slice(0, 8_193 - stdout.length);
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderrBytes = Math.min(4_097, stderrBytes + chunk.length);
        });
        child.once('error', () => finish(new ImageCdrChildError('failed')));
        child.once('exit', (code) => {
            if (timedOut) return finish(new ImageCdrChildError('timeout'));
            if (code !== 0 || stderrBytes > 4_096 || stdout.length > 8_192)
                return finish(new ImageCdrChildError('failed'));
            try {
                const value = JSON.parse(stdout) as ImageCdrChildResult;
                if (
                    !['image/jpeg', 'image/png'].includes(value.mimeType) ||
                    !Number.isInteger(value.width) ||
                    !Number.isInteger(value.height) ||
                    value.width < 1 ||
                    value.height < 1 ||
                    !/^sha256:[0-9a-f]{64}$/.test(value.checksum) ||
                    value.policyVersion !== 'image-cdr-v1' ||
                    value.safetyEvidence !== 'cdr_reencoded'
                )
                    throw new Error('invalid');
                finish(null, value);
            } catch {
                finish(new ImageCdrChildError('invalid_result'));
            }
        });
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
        }, options.timeoutMs);
        const kill = setTimeout(() => {
            if (!settled) child.kill('SIGKILL');
        }, options.timeoutMs + options.killGraceMs);
    });
}
