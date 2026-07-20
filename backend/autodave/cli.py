"""`autodave` CLI (§2, §3): a second client of the backend API — full headless coverage."""
from __future__ import annotations

import argparse
import getpass
import json
import sys
import time
import urllib.request

from . import paths, service


class Client:
    def __init__(self) -> None:
        bj = paths.backend_json()
        if not bj.exists():
            sys.exit("backend isn't up (no backend.json) — start it with "
                     "`autodave service install` or `autodave-backend`")
        info = json.loads(bj.read_text())
        self.base = f"http://127.0.0.1:{info['port']}"
        self.token = info["token"]

    def req(self, method: str, path: str, body: dict | None = None):
        r = urllib.request.Request(
            self.base + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
            method=method,
        )
        try:
            with urllib.request.urlopen(r, timeout=30) as resp:
                return json.loads(resp.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:300]
            sys.exit(f"{e.code}: {detail}")


def find_auto(c: Client, ref: str) -> dict:
    autos = c.req("GET", "/automations")
    for a in autos:
        if a["id"] == ref or a["name"].lower() == ref.lower():
            return a
    matches = [a for a in autos if ref.lower() in a["name"].lower()]
    if len(matches) == 1:
        return matches[0]
    sys.exit(f"no unique automation matches {ref!r} — "
             f"have: {', '.join(a['name'] for a in autos) or '(none)'}")


def cmd_list(c: Client, _args) -> None:
    for a in c.req("GET", "/automations"):
        chip = a["triggerChip"] + (" (off)" if a.get("triggersOff") else "")
        print(f"{a['name']:<32} {chip:<16} {a['lastStatus']:<11} "
              f"{a.get('resultChip') or ''}  [{a['id'][:8]}]")


def cmd_execute(c: Client, args) -> None:
    a = find_auto(c, args.automation)
    r = c.req("POST", f"/automations/{a['id']}/execute", {"trigger": "Manual"})
    print(f"started — execution {r['execId']}")
    if args.follow:
        follow_exec(c, r["execId"])


def follow_exec(c: Client, exec_id: str) -> None:
    # Logs are lazy (§19): poll the record for step/attempt structure, then
    # fetch each attempt's log file and print lines past the last seen seq.
    # An attempt fetched once after it reached a terminal status can't grow —
    # skip it on later polls instead of re-downloading its whole file forever.
    seen: dict[tuple, int] = {}   # (step index | None, attempt | None) → last printed seq
    settled: set[tuple] = set()
    while True:
        e = c.req("GET", f"/executions/{exec_id}")
        targets: list[tuple[int | None, int | None, bool]] = [(None, None, False)]  # the execution log
        for i, s in enumerate(e.get("steps", [])):
            for a in s.get("attempts") or []:
                terminal = a.get("status") not in ("executing", "queued")
                targets.append((i, a["n"], terminal))
        for step, attempt, terminal in targets:
            key = (step, attempt)
            if key in settled:
                continue
            q = "" if step is None else f"?step={step}&attempt={attempt}"
            lines = c.req("GET", f"/executions/{exec_id}/logs{q}").get("lines", [])
            last = seen.get(key, 0)
            for ln in lines:
                if ln["seq"] > last:
                    print(f"  {ln['t']} [{ln['k']}] {ln['text']}")
                    last = ln["seq"]
            seen[key] = last
            if terminal:
                settled.add(key)
        if e["status"] != "executing":
            print(f"→ {e['status']} in {e['dur']}")
            break
        time.sleep(1)


def cmd_execs(c: Client, args) -> None:
    execs = c.req("GET", "/executions")
    for e in execs[: args.n]:
        print(f"{e['started']:<22} {e['autoName']:<30} {e['ver']:<6} {e['status']:<11} "
              f"{e['dur']:<8} {e['trigger']:<9} [{e['id'][:8]}]")


def cmd_tail(c: Client, args) -> None:
    execs = c.req("GET", "/executions")
    target = None
    if args.execution:
        target = next((e for e in execs if e["id"].startswith(args.execution)), None)
    elif execs:
        target = execs[0]
    if not target:
        sys.exit("no execution found")
    follow_exec(c, target["id"])


def cmd_secrets(c: Client, args) -> None:
    if args.action == "list":
        for s in c.req("GET", "/secrets"):
            print(f"{s['name']:<28} used by: {s['usedBy']}")
    elif args.action == "set":
        value = args.value or getpass.getpass(f"value for {args.name}: ")
        c.req("PUT", f"/secrets/{args.name}", {"value": value})
        print("saved to your Keychain")
    elif args.action == "delete":
        c.req("DELETE", f"/secrets/{args.name}")
        print("removed from your Keychain")


def cmd_agents(c: Client, _args) -> None:
    for a in c.req("GET", "/agents"):
        star = "*" if a.get("default") else " "
        print(f"{star} {(a.get('name') or a['harness']):<24} {a['harness']:<12} "
              f"{a['model'] or 'default configured model'}")


def cmd_service(_c, args) -> None:
    print({"install": service.install, "uninstall": service.uninstall,
           "status": service.status, "restart": service.restart}[args.action]())


def main() -> None:
    ap = argparse.ArgumentParser(prog="autodave", description="Auto Dave from the command line")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="list automations")
    p = sub.add_parser("execute", help="execute an automation now")
    p.add_argument("automation")
    p.add_argument("-f", "--follow", action="store_true", help="stream logs until it finishes")
    p = sub.add_parser("executions", help="recent executions")
    p.add_argument("-n", type=int, default=20)
    p = sub.add_parser("tail", help="stream an execution's logs")
    p.add_argument("execution", nargs="?", help="execution id prefix (default: latest)")
    p = sub.add_parser("secrets", help="manage secrets")
    p.add_argument("action", choices=["list", "set", "delete"])
    p.add_argument("name", nargs="?")
    p.add_argument("value", nargs="?")
    sub.add_parser("agents", help="list agents")
    p = sub.add_parser("service", help="manage the launchd service")
    p.add_argument("action", choices=["install", "uninstall", "status", "restart"])

    args = ap.parse_args()
    c = Client() if args.cmd != "service" else None
    {
        "list": cmd_list, "execute": cmd_execute, "executions": cmd_execs, "tail": cmd_tail,
        "secrets": cmd_secrets, "agents": cmd_agents, "service": cmd_service,
    }[args.cmd](c, args)


if __name__ == "__main__":
    main()
