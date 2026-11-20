import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(backendRoot, '..');
const frontendRoot = join(workspaceRoot, 'meal_frontend');
const frontendAppRoot = join(frontendRoot, 'front');
const adminRoot = join(workspaceRoot, 'meal_admin');
const databaseScript = join(backendRoot, 'scripts', 'local-development-database.ps1');
const backendEnvironment = join(backendRoot, '.local', 'backend.env');
const checkOnly = process.argv.includes('--check');
const children = new Map();
let stopping = false;

const npmCli = process.env.npm_execpath;
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';

function npmArguments(args) {
    if (!npmCli) throw new Error('Запускайте этот сценарий командой npm run local:real.');
    return [npmCli, ...args];
}

async function requirePath(path, explanation) {
    try {
        await access(path);
    } catch {
        throw new Error(`${explanation}: ${path}`);
    }
}

function requireVersion(command, args, pattern, explanation) {
    const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
    if (result.error) throw new Error(`${explanation}: не удалось запустить проверку (${result.error.code}).`);
    const version = (result.stdout ?? '').trim();
    if (result.status !== 0 || !pattern.test(version))
        throw new Error(`${explanation}. Обнаружено: ${version || 'не найдено'}`);
}

async function assertPortFree(port) {
    await new Promise((resolvePromise, reject) => {
        const server = createServer();
        server.once('error', () => reject(new Error(`Порт ${port} уже занят. Остановите прежний запуск и повторите.`)));
        server.listen(port, '127.0.0.1', () => server.close(resolvePromise));
    });
}

function run(command, args, cwd, extraEnvironment = {}) {
    const result = spawnSync(command, args, {
        cwd,
        env: { ...process.env, ...extraEnvironment },
        encoding: 'utf8',
        shell: false,
        stdio: ['inherit', 'pipe', 'pipe'],
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) throw new Error(`Команда завершилась с ошибкой: ${command} ${args.join(' ')}`);
}

function launch(name, command, args, cwd, extraEnvironment = {}) {
    const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...extraEnvironment },
        shell: false,
        stdio: 'inherit',
    });
    children.set(name, child);
    child.once('exit', (code, signal) => {
        children.delete(name);
        if (!stopping) {
            console.error(`${name} неожиданно остановлен (${signal ?? code}).`);
            void stopAll(1);
        }
    });
}

async function waitFor(url, name, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
            if (response.ok) return;
        } catch {}
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
    throw new Error(`${name} не стал готов за ${Math.round(timeoutMs / 1000)} секунд: ${url}`);
}

async function stopAll(exitCode = 0) {
    if (stopping) return;
    stopping = true;
    console.log('\nОстанавливаю приложения. Локальная база и её данные остаются запущенными.');
    if (process.platform === 'win32') {
        for (const child of children.values()) {
            if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        }
    } else {
        for (const child of children.values()) child.kill('SIGTERM');
        await Promise.all(
            [...children.values()].map((child) => new Promise((resolvePromise) => child.once('exit', resolvePromise))),
        );
    }
    process.exit(exitCode);
}

async function preflight() {
    requireVersion(process.execPath, ['--version'], /^v24\./, 'Нужен Node.js 24');
    requireVersion(process.execPath, npmArguments(['--version']), /^11\./, 'Нужен npm 11');
    await requirePath(databaseScript, 'Не найден скрипт локальной базы');
    await requirePath(backendEnvironment, 'Сначала создайте локальную базу командой npm run local:db:create');
    for (const [root, name] of [
        [backendRoot, 'backend'],
        [frontendRoot, 'основного приложения'],
        [adminRoot, 'админки'],
    ]) {
        await requirePath(join(root, 'package.json'), `Не найден package.json ${name}`);
        await requirePath(join(root, 'node_modules'), `Сначала выполните npm ci в папке ${name}`);
    }
    for (const port of [3000, 3001, 3002]) await assertPortFree(port);
}

try {
    await preflight();
    if (checkOnly) {
        console.log('Предварительная проверка пройдена. Ничего не запускалось и не изменялось.');
        process.exit(0);
    }

    run(
        powershell,
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', databaseScript, '-Action', 'Start'],
        backendRoot,
    );
    run(process.execPath, npmArguments(['run', 'build']), backendRoot);

    launch(
        'Backend',
        process.execPath,
        ['--env-file-if-exists=.local/backend.env', '--env-file-if-exists=.env', 'dist/src/main.js'],
        backendRoot,
    );
    await waitFor('http://127.0.0.1:3001/health/live', 'Backend');
    await waitFor('http://127.0.0.1:3001/health/ready', 'Backend и база');

    launch('Основное приложение', process.execPath, npmArguments(['run', 'dev']), frontendRoot, {
        NEXT_PUBLIC_API_MODE: 'real',
        NEXT_PUBLIC_LEGAL_EVIDENCE_MODE: 'demonstration',
        BACKEND_ORIGIN: 'http://127.0.0.1:3001',
    });
    launch('Админка', process.execPath, npmArguments(['run', 'dev']), adminRoot, {
        VITE_API_MODE: 'real',
        BACKEND_ORIGIN: 'http://127.0.0.1:3001',
    });
    await Promise.all([
        waitFor('http://localhost:3000/auth', 'Основное приложение'),
        waitFor('http://localhost:3002/auth', 'Админка'),
    ]);

    run(process.execPath, npmArguments(['run', 'test:integration']), frontendRoot, {
        BACKEND_ORIGIN: 'http://127.0.0.1:3001',
        CLIENT_ORIGIN: 'http://localhost:3000',
        ADMIN_ORIGIN: 'http://localhost:3002',
    });

    console.log('\nПолноценный локальный запуск готов:');
    console.log('- основное приложение: http://localhost:3000');
    console.log('- админка: http://localhost:3002');
    console.log('- состояние backend: http://127.0.0.1:3001/health/ready');
    console.log('Нажмите Ctrl+C, чтобы остановить приложения. База сохранится и продолжит работать.');

    process.on('SIGINT', () => void stopAll(0));
    process.on('SIGTERM', () => void stopAll(0));
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    if (children.size > 0) await stopAll(1);
    process.exit(1);
}
