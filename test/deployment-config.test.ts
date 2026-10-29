import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const text = async (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

void test('production compose keeps database private and every image digest-pinned', async () => {
    const compose = await text('deploy/compose.production.yml');
    for (const name of ['POSTGRES_IMAGE', 'BACKEND_IMAGE', 'FRONTEND_IMAGE', 'ADMIN_IMAGE']) {
        assert.ok(compose.includes(`image: \${${name}:?`));
    }
    assert.match(compose, /meal-db:[\s\S]*internal: true/);
    assert.match(compose, /meal-egress:/);
    assert.match(compose, /MEAL_EGRESS_SUBNET:-172\.31\.0\.0\/24/);
    assert.doesNotMatch(compose, /5432:5432/);
    assert.match(compose, /meal-postgres-data:\/var\/lib\/postgresql(?:\r?\n|$)/);
    assert.doesNotMatch(compose, /PGDATA:|meal-postgres-data:\/var\/lib\/postgresql\/data/);
    assert.match(compose, /'\/tmp:rw,noexec,nosuid,nodev,size=128m'/);
    assert.match(compose, /'\/tmp:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=8m'/);
    assert.doesNotMatch(compose, /tmpfs:\s*\[\/tmp:rw,/);
    assert.match(compose, /127\.0\.0\.1:3001:3001/);
    assert.match(compose, /127\.0\.0\.1:3000:3000/);
    assert.match(compose, /127\.0\.0\.1:3002:8080/);
    assert.match(compose, /profiles: \[(?:"|')?tools(?:"|')?\]/);
    assert.equal([...compose.matchAll(/'\$\{MEAL_SECRETS_GID:-29001\}'/g)].length, 3);
    assert.equal([...compose.matchAll(/'29002'/g)].length, 1);
    assert.doesNotMatch(compose, /MEAL_OBSERVABILITY_GID/);
    assert.match(
        compose,
        /source: \/var\/lib\/meal-planner\/observability[\s\S]*target: \/run\/meal-observability[\s\S]*read_only: true[\s\S]*create_host_path: false/,
    );
    assert.doesNotMatch(compose, /docker\.sock/);
});

void test('host observability collector is bounded, atomic and systemd sandboxed', async () => {
    const collector = await text('deploy/host-observability-collector.py');
    assert.match(collector, /SERVICES = \("postgres", "backend", "worker", "frontend", "admin"\)/);
    assert.match(collector, /MAX_COMMAND_OUTPUT_BYTES = 32_768/);
    assert.match(collector, /COMMAND_TIMEOUT_SECONDS = 2\.0/);
    assert.match(collector, /shell=False/);
    assert.match(collector, /os\.O_EXCL \| os\.O_NOFOLLOW/);
    assert.match(collector, /os\.fsync\(directory_descriptor\)/);
    assert.match(collector, /collectorStatus"] == "partial"[\s\S]*return 0/);
    assert.doesNotMatch(collector, /collectorStatus"] == "partial"[\s\S]{0,160}return 1/);
    assert.doesNotMatch(collector, /shell=True|os\.system|eval\(|exec\(/);
    const service = await text('deploy/systemd/meal-observability-collector.service');
    assert.doesNotMatch(service, /Requires=docker\.service/);
    for (const directive of [
        'NoNewPrivileges=true',
        'CapabilityBoundingSet=',
        'PrivateNetwork=true',
        'ProtectSystem=strict',
        'ReadWritePaths=/var/lib/meal-planner/observability',
        'InaccessiblePaths=/etc/meal-planner/secrets',
    ])
        assert.ok(service.includes(directive), directive);
    assert.doesNotMatch(service, /RuntimeMaxSec=/, 'oneshot timeout is enforced by TimeoutStartSec');
    const timer = await text('deploy/systemd/meal-observability-collector.timer');
    assert.match(timer, /OnUnitActiveSec=60s/);
    assert.match(timer, /Persistent=false/);
    assert.equal((await text('deploy/sysusers.d/meal-observability.conf')).trim(), 'g meal-observability 29002 -');
    assert.equal(
        (await text('deploy/tmpfiles.d/meal-observability.conf')).trim(),
        'd /var/lib/meal-planner/observability 2750 root meal-observability -',
    );
    const verify = await text('deploy/verify.sh');
    assert.match(verify, /docker\.sock/);
    assert.match(verify, /OBSERVABILITY_HOST_SNAPSHOT_ENABLED/);
    assert.match(verify, /Enabled host observability snapshot is not safely readable/);
    assert.match(verify, /HostSnapshotReader/);
    assert.match(verify, /snapshot\.freshness\.state!==['"]fresh['"]/);
    assert.match(verify, /0 29002 2750/);
    assert.match(verify, /must not mount observability data/);
});

void test('backend build uses the verified immutable Node base', async () => {
    const dockerfile = await text('Dockerfile');
    assert.match(
        dockerfile,
        /node:24\.19\.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df/,
    );
    assert.equal([...dockerfile.matchAll(/FROM \$\{NODE_IMAGE\}/g)].length, 3);
    assert.match(dockerfile, /COPY contracts \.\/contracts/);
    assert.match(dockerfile, /scripts\/run-worker-scheduler\.mjs/);
    assert.match(dockerfile, /scripts\/run-scheduled-task\.mjs/);
    assert.match(dockerfile, /scripts\/check-worker-health\.mjs/);
});

void test('host Nginx keeps TLS at the edge and proxies only loopback application ports', async () => {
    const nginx = await text('deploy/nginx/meal-planner.conf');
    assert.match(nginx, /server_name meal\.royalexander\.online;/);
    assert.match(nginx, /server_name admin\.meal\.royalexander\.online;/);
    assert.match(nginx, /server_name abstract-usable-gazebo\.ruweb\.place;/);
    assert.match(nginx, /server_name admin\.abstract-usable-gazebo\.ruweb\.place;/);
    assert.match(nginx, /live\/meal\.royalexander\.online\/fullchain\.pem/);
    assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
    assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3001;/);
    assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3002;/);
    assert.doesNotMatch(nginx, /root \/srv\/meal\/admin/);
    assert.match(nginx, /return 301 https:\/\/\$host\$request_uri;/);
    assert.match(nginx, /return 302 https:\/\/meal\.royalexander\.online\$request_uri;/);
    assert.match(nginx, /return 302 https:\/\/admin\.meal\.royalexander\.online\$request_uri;/);
    assert.match(nginx, /location \^~ \/api\/ \{[\s\S]*?Cache-Control "no-store"[\s\S]*?return 410;/);
    assert.doesNotMatch(nginx, /server_name (?:www\.)?royalexander\.online;/);
});

void test('component deployment isolates UI rollout from database migration', async () => {
    const deploy = await text('deploy/deploy.sh');
    assert.match(deploy, /--component/);
    assert.match(deploy, /if \[ "\$component" = backend \]; then/);
    assert.match(deploy, /compose pull backend worker/);
    assert.match(deploy, /compose up -d --no-deps backend worker/);
    assert.match(deploy, /persist_images/);
    assert.match(deploy, /compose up -d --no-deps "\$component"/);
    assert.match(deploy, /ALLOW_BACKEND_AUTO_ROLLBACK/);
    assert.match(deploy, /BACKEND_ROLLBACK_EVIDENCE_FILE/);
    assert.match(deploy, /Observability host bootstrap is required before the first backend rollout/);
    assert.match(deploy, /0 29002 2750/);
    assert.ok(
        deploy.indexOf('Observability host bootstrap is required') < deploy.indexOf('compose config --quiet'),
        'host bootstrap gate must run before compose rollout',
    );
    const observabilityRunbook = await text('docs/observability-runbook.md');
    assert.match(observabilityRunbook, /install -d -o root -g root -m 0755 \/usr\/local\/libexec\/meal-planner/);
    assert.match(observabilityRunbook, /\[ ! -s "\$backup_dir\/SHA256SUMS" \] \|\|/);
    assert.match(observabilityRunbook, /CANDIDATE_SHA256SUMS/);
    assert.match(observabilityRunbook, /candidate_stage/);
    assert.match(
        observabilityRunbook,
        /install -d -o root -g root -m 0755 \/usr\/local\/libexec\/meal-planner \/etc\/sysusers\.d \/etc\/tmpfiles\.d/,
    );
    assert.match(observabilityRunbook, /до первого rollout compose-файла/);
    const wrapper = await text('deploy/meal-deploy');
    assert.match(wrapper, /\[ "\$#" -eq 3 \]/);
    assert.match(wrapper, /meal_backend@sha256/);
    assert.match(wrapper, /meal_frontend@sha256/);
    assert.match(wrapper, /meal_admin@sha256/);
    const workflow = await text('.github/workflows/deploy.yml');
    assert.doesNotMatch(workflow, /workflow_dispatch/);
    assert.equal([...workflow.matchAll(/Reject stale main tip/g)].length, 3);
    assert.match(workflow, /\/usr\/local\/sbin\/meal-deploy backend/);
    const bootstrap = await text('deploy/bootstrap-restore.sh');
    const grants = await text('database/application-grants.sql');
    assert.match(grants, /GRANT USAGE ON SCHEMA meal TO meal_app;/);
    assert.match(bootstrap, /Target volume is not empty; restore refused/);
    assert.match(bootstrap, /systemctl is-active/);
    assert.match(bootstrap, /validate_network_route meal-egress/);
    const verify = await text('deploy/verify.sh');
    assert.match(verify, /wait_healthy worker/);
    assert.match(verify, /health_attempts=\$\{2:-45\}/);
    assert.match(verify, /sleep 2/);
    assert.doesNotMatch(verify, /require_healthy worker/);
    assert.match(verify, /TRUSTED_PROXY_CIDRS must equal the exact Docker gateway \/32 addresses/);
    assert.match(verify, /grep -E '\^\[0-9\]\{1,3\}/);
    const proxySmoke = await text('deploy/proxy-smoke.sh');
    assert.match(proxySmoke, /X-Forwarded-For/);
    assert.match(proxySmoke, /Runtime proxy source verified by admin guard/);
    assert.match(bootstrap, /29\/209\/483\/18/);
    assert.match(bootstrap, /meal_runtime/);
    assert.match(bootstrap, /chown postgres:postgres "\$restore_path"/);
    assert.match(bootstrap, /chmod 0600 "\$restore_path"/);
    assert.match(bootstrap, /--username "\$\{POSTGRES_USER:-meal_owner\}" --no-owner/);
    const stack = await text('deploy/stack.sh');
    assert.match(stack, /compose up -d/);
    assert.doesNotMatch(stack, /migrate|db:migrate/);
    const systemd = await text('deploy/systemd/meal-planner-compose.service');
    assert.match(systemd, /Requires=docker\.service/);
    assert.match(systemd, /ExecStart=\/bin\/sh \/srv\/meal\/deployment\/stack\.sh up/);
    assert.match(systemd, /ExecStop=\/bin\/sh \/srv\/meal\/deployment\/stack\.sh stop/);
});
