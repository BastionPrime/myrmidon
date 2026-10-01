#!/usr/bin/env python3
"""Regression test for the state-DB descriptor probe on the gateway event loop.

Before each state-DB write the gateway re-checks that the WAL/SHM generation this
handle opened is still the one on disk. When the handle has no recorded sidecar
identity, that check walks /proc/self/fd and readlinks every open descriptor of the
process — synchronously, on the thread that issued the write, i.e. on the gateway's
event loop. The identity stays unrecorded whenever the sidecars do not sit next to
the path hermes was given: a `state.db` reached through a symlink is opened by SQLite
at its target, so `-wal`/`-shm` live next to the target and the literal
`<path>-wal` never stats. The check therefore runs the full descriptor walk on every
write, for the whole life of the handle.

A multi-profile gateway holds one state.db per profile and carries hundreds of
descriptors, so a burst of writes keeps the loop inside readlink(). The out-of-loop
liveness watchdog counts an unprocessed probe as a miss after
`gateway.shutdown_watchdog.DEFAULT_LOOP_WATCHDOG_TIMEOUT_S` (10 s) and hard-exits the
gateway (exit 75) after `DEFAULT_LOOP_WATCHDOG_MAX_STRIKES` (3) of them around the
30 s probe interval, failing every run in flight.

This test pins the contract the image relies on: with roughly 500 descriptors held
and a burst of writes on the event loop, the number of descriptor walks is a
function of time, not of the write count, and the loop latency a co-running probe
observes stays far below the watchdog's per-probe timeout.

Run it against a hermes checkout (default: the current directory, then
/opt/hermes-src):

    python3 tests/state_db_fd_probe_budget.py [hermes-checkout-dir]

Exits non-zero, printing the measured numbers, when the contract is broken.
"""

import asyncio
import os
import sys
import tempfile
import time
from pathlib import Path

FD_COUNT = 500
WRITES = 2500
# The watchdog's per-probe timeout: an unprocessed probe counts as a miss after this
# many seconds, and three consecutive misses hard-exit the gateway.
LOOP_TIMEOUT_S = 10.0
# The floor between two descriptor walks on one handle. Read from the class so the test
# follows the delta's own value instead of freezing a copy; the default matches it.
DEFAULT_PROBE_INTERVAL_S = 1.0


def _hermes_dir(argv):
    for candidate in (argv[1] if len(argv) > 1 else None, os.getcwd(), "/opt/hermes-src"):
        if candidate and Path(candidate, "hermes_state.py").is_file():
            return Path(candidate)
    sys.exit("cannot find a hermes checkout (pass its directory as the first argument)")


def main(argv):
    hermes_dir = _hermes_dir(argv)
    home = Path(tempfile.mkdtemp(prefix="state-db-probe-"))
    os.environ["HERMES_HOME"] = str(home)
    sys.path.insert(0, str(hermes_dir))

    import hermes_state as state
    import hermes_state_wal as wal

    # The probe branch only runs while WAL is active on the handle. A runtime whose
    # linked SQLite predates the WAL-reset fix (3.51.3+, backports 3.50.7 / 3.44.6) is
    # kept out of WAL by hermes, and then there is no sidecar generation to lose and no
    # probe to measure. Force the WAL path so the measured code is the gateway's, and
    # fail loudly below if WAL still did not stick.
    wal.is_sqlite_wal_reset_vulnerable = lambda *a, **k: False

    walk_durations = []
    real_targets = state._proc_fd_targets

    def counting_targets(pid):
        started = time.monotonic()
        try:
            for entry in real_targets(pid):
                yield entry
        finally:
            walk_durations.append(time.monotonic() - started)

    state._proc_fd_targets = counting_targets

    held = []
    try:
        for _ in range(FD_COUNT):
            held.append(os.open(__file__, os.O_RDONLY))
        open_fds = len(os.listdir("/proc/self/fd"))

        # The database lives on its own path; the profile reaches it through a symlink,
        # which is what makes the sidecar identity unrecordable (see the module comment).
        target = home / "data" / "state.db"
        target.parent.mkdir(parents=True, exist_ok=True)
        seed = state.SessionDB(target)
        seed._write_sql("CREATE TABLE IF NOT EXISTS probe (x INTEGER)")
        seed.close()
        link = home / "state.db"
        link.symlink_to(target)

        db = state.SessionDB(link)
        db._write_sql("INSERT INTO probe (x) VALUES (0)")
        if not db._wal_active:
            sys.exit(f"FAIL: state.db did not end up in WAL (open fds={open_fds})")
        if db._db_sidecar_identity:
            sys.exit(
                "FAIL: the symlinked state.db recorded a sidecar identity — the walk "
                "setup no longer reproduces the unrecorded-identity state"
            )

        gaps = []

        async def heartbeat(stop):
            last = time.monotonic()
            while not stop.is_set():
                await asyncio.sleep(0.01)
                now = time.monotonic()
                gaps.append(now - last)
                last = now

        async def burst():
            stop = asyncio.Event()
            task = asyncio.create_task(heartbeat(stop))
            interval = getattr(state.SessionDB, "_WAL_PROBE_MIN_INTERVAL_S", DEFAULT_PROBE_INTERVAL_S)
            started = time.monotonic()
            written = 0
            # WRITES records, and then records until the clock has passed one probe
            # interval, so the "at least one walk" clause below means the same thing on a
            # fast runner as on a slow one. The cap keeps a pathological host bounded.
            while written < WRITES or time.monotonic() - started < interval + 0.5:
                db._write_sql("INSERT INTO probe (x) VALUES (?)", (written,))
                written += 1
                if written >= WRITES * 12:
                    break
            duration = time.monotonic() - started
            stop.set()
            await task
            return duration, written

        walk_durations.clear()
        duration, written = asyncio.run(burst())
        walk_count = len(walk_durations)
        walk_total_ms = sum(walk_durations) * 1000.0
        max_gap_s = max(gaps) if gaps else 0.0
        db.close()
    finally:
        for fd in held:
            try:
                os.close(fd)
            except OSError:
                pass

    # Contract: the walk count follows the clock, not the number of writes.
    interval = getattr(state.SessionDB, "_WAL_PROBE_MIN_INTERVAL_S", DEFAULT_PROBE_INTERVAL_S)
    allowed = max(4, int(duration / interval) + 3)
    print(
        f"open_fds={open_fds} writes={written} duration_s={duration:.3f} "
        f"fd_walks={walk_count} fd_walk_total_ms={walk_total_ms:.1f} "
        f"max_loop_gap_ms={max_gap_s * 1000:.1f}"
    )
    failures = []
    if walk_count > allowed:
        failures.append(
            f"{walk_count} /proc/self/fd walks for {written} writes in {duration:.3f}s "
            f"({walk_total_ms:.1f} ms on the event loop) — the walk scales with the write "
            f"count instead of the clock (allowed {allowed})"
        )
    if walk_count < 1:
        failures.append(
            f"no /proc/self/fd walk in {duration:.3f}s of writes — a lost WAL generation "
            f"would never be noticed"
        )
    if max_gap_s >= LOOP_TIMEOUT_S:
        failures.append(
            f"event-loop latency {max_gap_s * 1000:.1f} ms reached the watchdog's "
            f"{LOOP_TIMEOUT_S:.0f} s probe timeout"
        )
    if failures:
        for line in failures:
            print(f"FAIL: {line}")
        return 1
    print("PASS: descriptor walks stay bounded and the event loop stays live")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))