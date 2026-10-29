#!/usr/bin/python3
"""Write a bounded host/container snapshot without exposing Docker internals."""

from __future__ import annotations

import datetime as dt
import grp
import json
import math
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any


OUTPUT_DIRECTORY = Path("/var/lib/meal-planner/observability")
OUTPUT_FILE = OUTPUT_DIRECTORY / "current.json"
OUTPUT_GROUP = "meal-observability"
EXPECTED_GROUP_ID = 29002
MAX_COMMAND_OUTPUT_BYTES = 32_768
MAX_SNAPSHOT_BYTES = 65_536
COMMAND_TIMEOUT_SECONDS = 2.0
COMPOSE_PROJECT = "meal-planner"
SERVICES = ("postgres", "backend", "worker", "frontend", "admin")
FILESYSTEMS = (("root", Path("/")), ("deployment", Path("/srv")), ("backups", Path("/var/backups")))
CONTAINER_STATES = {"created", "running", "paused", "restarting", "exited", "missing", "unknown"}
HEALTH_STATES = {"healthy", "unhealthy", "starting", "none", "unknown"}
SAFE_ENVIRONMENT = {
    "HOME": "/",
    "LANG": "C",
    "LC_ALL": "C",
    "PATH": "/usr/bin:/bin",
    "DOCKER_CONFIG": "/nonexistent",
}
CONTAINER_ID = re.compile(r"^[0-9a-f]{12,64}$")
SIZE_VALUE = re.compile(r"^([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?i?B)$")
SIZE_MULTIPLIERS = {
    "B": Decimal(1),
    "KB": Decimal(1_000),
    "MB": Decimal(1_000_000),
    "GB": Decimal(1_000_000_000),
    "TB": Decimal(1_000_000_000_000),
    "KiB": Decimal(1_024),
    "MiB": Decimal(1_048_576),
    "GiB": Decimal(1_073_741_824),
    "TiB": Decimal(1_099_511_627_776),
}


class CollectionFailure(Exception):
    """Internal failure whose details must not reach journal output."""


def bounded_integer(value: Any, maximum: int) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if 0 <= number <= maximum else None


def bounded_decimal(value: str, multiplier: int, maximum: int) -> int | None:
    try:
        number = Decimal(value.strip().removesuffix("%")) * multiplier
    except (InvalidOperation, ValueError):
        return None
    if not number.is_finite() or number < 0 or number > maximum:
        return None
    return int(number.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def parse_size(value: str) -> int | None:
    match = SIZE_VALUE.fullmatch(value.strip())
    if not match:
        return None
    try:
        size = Decimal(match.group(1)) * SIZE_MULTIPLIERS[match.group(2)]
    except (InvalidOperation, KeyError):
        return None
    if not size.is_finite() or size < 0 or size > 2**63 - 1:
        return None
    return int(size.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def run_command(argv: list[str]) -> str | None:
    try:
        process = subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd="/",
            env=SAFE_ENVIRONMENT,
            shell=False,
            start_new_session=True,
        )
    except OSError:
        return None
    if process.stdout is None:
        process.kill()
        process.wait()
        return None

    output = bytearray()
    deadline = time.monotonic() + COMMAND_TIMEOUT_SECONDS
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    failed = False
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                failed = True
                break
            events = selector.select(min(0.1, remaining))
            if not events:
                if process.poll() is not None:
                    # The pipe will become readable with EOF; keep the same bounded loop to drain it.
                    continue
                continue
            chunk = os.read(process.stdout.fileno(), min(4_096, MAX_COMMAND_OUTPUT_BYTES + 1 - len(output)))
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > MAX_COMMAND_OUTPUT_BYTES:
                failed = True
                break
    except OSError:
        failed = True
    finally:
        selector.close()

    if failed:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        return_code = process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        return None
    if failed or return_code != 0:
        return None
    try:
        return bytes(output).decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return None


def read_text(path: Path, maximum_bytes: int) -> str | None:
    try:
        with path.open("rb") as stream:
            value = stream.read(maximum_bytes + 1)
    except OSError:
        return None
    if len(value) > maximum_bytes:
        return None
    try:
        return value.decode("ascii", errors="strict")
    except UnicodeDecodeError:
        return None


def proc_snapshot() -> tuple[dict[str, Any], bool]:
    complete = True
    load = None
    load_text = read_text(Path("/proc/loadavg"), 4_096)
    if load_text:
        try:
            candidate = float(load_text.split()[0])
            if math.isfinite(candidate) and 0 <= candidate <= 1_000:
                load = round(candidate * 1_000)
        except (ValueError, IndexError):
            pass
    if load is None:
        complete = False

    uptime = None
    uptime_text = read_text(Path("/proc/uptime"), 4_096)
    if uptime_text:
        try:
            candidate = float(uptime_text.split()[0])
            if math.isfinite(candidate) and 0 <= candidate <= 10**9:
                uptime = round(candidate)
        except (ValueError, IndexError):
            pass
    if uptime is None:
        complete = False

    memory_total = None
    memory_available = None
    memory_text = read_text(Path("/proc/meminfo"), 65_536)
    if memory_text:
        for line in memory_text.splitlines():
            parts = line.split()
            if len(parts) != 3 or parts[2] != "kB":
                continue
            value = bounded_integer(parts[1], (2**63 - 1) // 1_024)
            if value is None:
                continue
            if parts[0] == "MemTotal:":
                memory_total = value * 1_024
            elif parts[0] == "MemAvailable:":
                memory_available = value * 1_024
    if memory_total is None or memory_available is None or memory_available > memory_total:
        memory_total = None
        memory_available = None
        complete = False

    return (
        {
            "memoryTotalBytes": memory_total,
            "memoryAvailableBytes": memory_available,
            "load1mMilli": load,
            "uptimeSeconds": uptime,
            "rebootRequired": Path("/run/reboot-required").exists(),
        },
        complete,
    )


def filesystem_snapshot() -> tuple[list[dict[str, Any]], bool]:
    result: list[dict[str, Any]] = []
    complete = True
    for scope, path in FILESYSTEMS:
        total = available = used_percent = None
        try:
            data = os.statvfs(path)
            total = data.f_blocks * data.f_frsize
            available = data.f_bavail * data.f_frsize
            if total <= 0 or total > 2**63 - 1 or available < 0 or available > total:
                raise ValueError
            used_percent = round((total - available) * 100 / total)
        except (OSError, ValueError, OverflowError, ZeroDivisionError):
            total = available = used_percent = None
            complete = False
        result.append(
            {"scope": scope, "totalBytes": total, "availableBytes": available, "usedPercent": used_percent}
        )
    return result, complete


def service_container_ids() -> tuple[dict[str, list[str]], bool]:
    output = run_command(
        [
            "/usr/bin/docker",
            "ps",
            "-a",
            "--filter",
            f"label=com.docker.compose.project={COMPOSE_PROJECT}",
            "--format",
            '{{.ID}} {{.Label "com.docker.compose.service"}}',
        ]
    )
    ids = {service: [] for service in SERVICES}
    if output is None:
        return ids, False
    valid = True
    for line in output.splitlines():
        parts = line.split()
        if len(parts) != 2 or not CONTAINER_ID.fullmatch(parts[0]):
            valid = False
            continue
        if parts[1] in ids:
            ids[parts[1]].append(parts[0])
    return ids, valid


def empty_container(service: str, state: str = "unknown") -> dict[str, Any]:
    return {
        "service": service,
        "state": state,
        "health": "none" if state == "missing" else "unknown",
        "restartCount": None,
        "cpuPermille": None,
        "memoryBytes": None,
        "memoryLimitBytes": None,
        "pids": None,
    }


def inspect_container(service: str, container_id: str) -> tuple[dict[str, Any], bool]:
    inspection = run_command(
        [
            "/usr/bin/docker",
            "inspect",
            "--format",
            '{{json .State.Status}}|{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}}|{{.RestartCount}}',
            container_id,
        ]
    )
    if inspection is None:
        return empty_container(service), False
    parts = inspection.strip().split("|")
    if len(parts) != 3:
        return empty_container(service), False
    try:
        state = json.loads(parts[0])
        health = json.loads(parts[1])
    except (json.JSONDecodeError, TypeError):
        return empty_container(service), False
    restart_count = bounded_integer(parts[2], 1_000_000)
    if state not in CONTAINER_STATES or health not in HEALTH_STATES or restart_count is None:
        return empty_container(service), False

    if state != "running":
        return (
            {
                "service": service,
                "state": state,
                "health": health,
                "restartCount": restart_count,
                "cpuPermille": None,
                "memoryBytes": None,
                "memoryLimitBytes": None,
                "pids": None,
            },
            True,
        )

    stats = run_command(
        [
            "/usr/bin/docker",
            "stats",
            "--no-stream",
            "--format",
            '{{json .CPUPerc}}|{{json .MemUsage}}|{{json .PIDs}}',
            container_id,
        ]
    )
    cpu = memory = memory_limit = pids = None
    stats_valid = stats is not None
    if stats is not None:
        stats_parts = stats.strip().split("|")
        if len(stats_parts) == 3:
            try:
                cpu_text = json.loads(stats_parts[0])
                memory_text = json.loads(stats_parts[1])
                pids_text = json.loads(stats_parts[2])
                memory_parts = memory_text.split("/") if isinstance(memory_text, str) else []
                cpu = bounded_decimal(cpu_text, 10, 1_000_000) if isinstance(cpu_text, str) else None
                memory = parse_size(memory_parts[0]) if len(memory_parts) == 2 else None
                memory_limit = parse_size(memory_parts[1]) if len(memory_parts) == 2 else None
                pids = bounded_integer(pids_text, 1_000_000)
            except (json.JSONDecodeError, AttributeError, TypeError):
                pass
        if cpu is None or memory is None or memory_limit is None or pids is None:
            stats_valid = False
    return (
        {
            "service": service,
            "state": state,
            "health": health,
            "restartCount": restart_count,
            "cpuPermille": cpu,
            "memoryBytes": memory,
            "memoryLimitBytes": memory_limit,
            "pids": pids,
        },
        stats_valid,
    )


def container_snapshot() -> tuple[list[dict[str, Any]], bool]:
    ids, complete = service_container_ids()
    result: list[dict[str, Any]] = []
    for service in SERVICES:
        candidates = ids[service]
        if not candidates:
            result.append(empty_container(service, "missing"))
        elif len(candidates) != 1:
            result.append(empty_container(service))
            complete = False
        else:
            value, valid = inspect_container(service, candidates[0])
            result.append(value)
            complete = complete and valid
    return result, complete


def output_group_id() -> int:
    try:
        group_id = grp.getgrnam(OUTPUT_GROUP).gr_gid
    except KeyError as error:
        raise CollectionFailure from error
    if group_id != EXPECTED_GROUP_ID:
        raise CollectionFailure
    return group_id


def validate_output_directory(group_id: int) -> None:
    try:
        metadata = os.lstat(OUTPUT_DIRECTORY)
    except OSError as error:
        raise CollectionFailure from error
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_uid != 0
        or metadata.st_gid != group_id
        or stat.S_IMODE(metadata.st_mode) != 0o2750
    ):
        raise CollectionFailure


def atomic_write(snapshot: dict[str, Any]) -> None:
    group_id = output_group_id()
    validate_output_directory(group_id)
    payload = (json.dumps(snapshot, ensure_ascii=True, separators=(",", ":"), allow_nan=False) + "\n").encode("ascii")
    if len(payload) > MAX_SNAPSHOT_BYTES:
        raise CollectionFailure
    temporary = OUTPUT_DIRECTORY / f".current.{os.getpid()}.tmp"
    descriptor = None
    directory_descriptor = None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
        os.fchown(descriptor, 0, group_id)
        os.fchmod(descriptor, 0o640)
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            descriptor = None
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, OUTPUT_FILE)
        directory_descriptor = os.open(OUTPUT_DIRECTORY, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        os.fsync(directory_descriptor)
    except OSError as error:
        raise CollectionFailure from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if directory_descriptor is not None:
            os.close(directory_descriptor)
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def collect() -> dict[str, Any]:
    started = time.monotonic()
    host, proc_complete = proc_snapshot()
    filesystems, filesystem_complete = filesystem_snapshot()
    containers, docker_complete = container_snapshot()
    complete = proc_complete and filesystem_complete and docker_complete
    collected_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return {
        "schemaVersion": 1,
        "collectedAt": collected_at,
        "collectorStatus": "ok" if complete else "partial",
        "durationMs": max(0, min(30_000, round((time.monotonic() - started) * 1_000))),
        "host": {**host, "filesystems": filesystems},
        "containers": containers,
    }


def main() -> int:
    if len(sys.argv) != 1:
        print("host observability collector rejected arguments", file=sys.stderr)
        return 64
    try:
        snapshot = collect()
        atomic_write(snapshot)
    except (CollectionFailure, OSError, ValueError, TypeError):
        print("host observability collector failed", file=sys.stderr)
        return 1
    if snapshot["collectorStatus"] == "partial":
        print("host observability collector produced a partial snapshot", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
