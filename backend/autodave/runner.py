"""Per-step subprocess runner + the `autodave` step SDK (§6.1).

Invoked as `python -m autodave.runner <script.py>` with a JSON context on
stdin (never argv/env — secrets travel on the pipe). Injects the SDK globals,
executes the script, and reports structured events as `@@AD@@{json}` control
lines on stdout. Plain stdout/stderr lines become out/err log lines.
"""
from __future__ import annotations

import io
import json
import sys
import time
import traceback
import urllib.robotparser
import urllib.request
from pathlib import Path

# Import before main() replaces sys.modules["autodave"] with the SDK shim.
from . import harness as _harness
from .imports_check import disallowed_imports

CTRL = "@@AD@@"
USER_AGENT = "AutoDave/1.0"

_real_stdout = sys.stdout


def emit(op: str, **kw) -> None:
    _real_stdout.write(CTRL + json.dumps({"op": op, **kw}, ensure_ascii=False) + "\n")
    _real_stdout.flush()


class MissingSecret(Exception):
    pass


class Secrets:
    def __init__(self, values: dict[str, str], allowed: list[str]):
        self._values = values
        self._allowed = set(allowed)

    def __getattr__(self, name: str) -> str:
        if name.startswith("_"):
            raise AttributeError(name)
        if name not in self._allowed:
            raise MissingSecret(f"secret {name} is not allowed for this automation")
        if name not in self._values:
            raise MissingSecret(f"secret {name} is not in your Keychain")
        return self._values[name]


class Memory:
    """Path-like handle on the automation's memory dir + YAML helpers."""

    def __init__(self, root: str):
        self.path = Path(root)
        self.path.mkdir(parents=True, exist_ok=True)

    def __fspath__(self) -> str:
        return str(self.path)

    def __truediv__(self, other: str) -> Path:
        return self.path / other

    def load(self, name: str, default=None):
        import yaml

        f = self.path / (name if "." in name else name + ".yaml")
        if not f.exists():
            return default
        return yaml.safe_load(f.read_text(encoding="utf-8"))

    def save(self, name: str, obj) -> None:
        import yaml

        f = self.path / (name if "." in name else name + ".yaml")
        f.write_text(yaml.safe_dump(obj, sort_keys=False, allow_unicode=True), encoding="utf-8")


class Log:
    def __call__(self, text: str) -> None:
        emit("log", k="out", text=str(text))

    def info(self, text: str) -> None:
        emit("log", k="out", text=str(text))

    def warn(self, text: str) -> None:
        emit("log", k="wrn", text=str(text))

    def error(self, text: str) -> None:
        emit("log", k="err", text=str(text))


class Result:
    """§6.1 result builder. Values go to result.yaml via the engine; any other
    output files are written directly into `result.path` (result.md, images, …)."""

    def __init__(self, root: str):
        self.path = Path(root)
        self.path.mkdir(parents=True, exist_ok=True)

    def __fspath__(self) -> str:
        return str(self.path)

    def __truediv__(self, other: str) -> Path:
        return self.path / other

    def status(self, s: str) -> None:
        if s not in ("changes", "ok", "attention"):
            raise ValueError("result.status must be changes | ok | attention")
        emit("result", field="status", value=s)

    def chip(self, text: str) -> None:
        emit("result", field="chip", value=str(text))

    def chips(self, items) -> None:
        emit("result", field="chips", value=[str(x) for x in items])

    def value(self, name: str, value) -> None:
        if isinstance(value, (list, tuple)):
            v: object = [str(x) for x in value]
        else:
            v = str(value)
        emit("result", field="value", value={"name": str(name), "value": v})


class Agent:
    def __init__(self, ctx: dict):
        self._ctx = ctx

    def ask(self, prompt: str, data=None) -> str:
        return self._ask(prompt, data)

    # prototype scripts use agent.read(page, q) / agent.write(rows, q)
    def read(self, data, prompt: str) -> str:
        return self._ask(prompt, data)

    def write(self, data, prompt: str) -> str:
        return self._ask(prompt, data)

    def _ask(self, prompt: str, data) -> str:
        cfg = self._ctx.get("agent")
        if not self._ctx.get("is_agent_step"):
            raise RuntimeError("agent calls are only available in steps marked as agent steps")
        if not cfg:
            raise RuntimeError("no enabled agent for this step")
        full = str(prompt) if data is None else f"question: {prompt}\n\ndata:\n{data}"
        # §6: secret values must never enter a prompt — scan before sending.
        # Multi-line values are also checked line by line, so a partial paste
        # (one line of a key) is caught too.
        for name in self._ctx.get("secret_names_with_values", []):
            val = self._ctx["secrets"].get(name)
            if not val:
                continue
            probes = [val] + [p for p in val.splitlines() if p.strip()] if "\n" in val else [val]
            if any(p in full for p in probes):
                raise RuntimeError(f"prompt contains the value of secret {name} — refusing to send")
        emit("log", k="sys", text=f"agent query → {cfg.get('harness')} ({len(full)} chars)")
        if len(full) > 200_000:
            raise RuntimeError("agent prompt too large (200k char cap)")
        reply = _harness.invoke(cfg, full, timeout=self._ctx.get("agent_timeout", 120))
        if len(reply) > 200_000:
            raise RuntimeError("agent reply too large (200k char cap)")
        # §6: the FULL prompt/reply go to logs for audit (already size-capped above).
        emit("agent_audit", prompt=full, reply=reply)
        return reply.strip()


_site_last: dict[str, float] = {}
_robots: dict[str, urllib.robotparser.RobotFileParser] = {}


def fetch_page(url: str) -> str:
    """§6 web policies: 10s timeout, ≥2s per-site spacing, retry twice, robots.txt, UA."""
    from urllib.parse import urlparse

    host = urlparse(url).netloc
    rp = _robots.get(host)
    if rp is None:
        rp = urllib.robotparser.RobotFileParser()
        try:
            rp.set_url(f"{urlparse(url).scheme}://{host}/robots.txt")
            rp.read()
        except Exception:  # noqa: BLE001
            rp.allow_all = True  # type: ignore[attr-defined]
        _robots[host] = rp
    try:
        allowed = rp.can_fetch(USER_AGENT, url)
    except Exception:  # noqa: BLE001
        allowed = True
    if not allowed:
        raise RuntimeError(f"robots.txt disallows fetching {url}")
    wait = _site_last.get(host, 0) + 2.0 - time.time()
    if wait > 0:
        time.sleep(wait)
    last_err: Exception | None = None
    for _ in range(3):  # first try + retry twice
        _site_last[host] = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.read().decode("utf-8", errors="replace")
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(2)
    raise RuntimeError(f"couldn't fetch {url}: {last_err}")


class _LineWriter(io.TextIOBase):
    def __init__(self, kind: str):
        self.kind = kind
        self.buf = ""

    def write(self, s: str) -> int:  # type: ignore[override]
        self.buf += s
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            if line.strip():
                emit("log", k=self.kind, text=line)
        return len(s)

    def flush(self) -> None:
        if self.buf.strip():
            emit("log", k=self.kind, text=self.buf)
        self.buf = ""


def main() -> int:
    script = sys.argv[1]
    ctx = json.load(sys.stdin)
    ctx.setdefault("secret_names_with_values", list(ctx.get("secrets", {}).keys()))
    workspace = Path(ctx["workspace"])
    workspace.mkdir(parents=True, exist_ok=True)
    import os

    os.chdir(workspace)

    notify_holder = {}

    def notify(text: str) -> None:
        notify_holder["text"] = str(text)
        emit("notify", text=str(text))

    g = {
        "__name__": "__main__",
        "__file__": script,
        "params": ctx.get("params", {}),
        "secrets": Secrets(ctx.get("secrets", {}), ctx.get("allowed_secrets", [])),
        "memory": Memory(ctx["memory_dir"]),
        "workspace": workspace,
        "log": Log(),
        "result": Result(ctx["result_dir"]),
        "notify": notify,
        "agent": Agent(ctx),
        "fetch_page": fetch_page,
    }
    # `import autodave` inside a step resolves to this same SDK surface.
    import types

    sdk_mod = types.ModuleType("autodave")
    for k, v in g.items():
        if not k.startswith("__"):
            setattr(sdk_mod, k, v)
    sys.modules["autodave"] = sdk_mod

    sys.stdout = _LineWriter("out")  # type: ignore[assignment]
    sys.stderr = _LineWriter("err")  # type: ignore[assignment]
    try:
        source = Path(script).read_text(encoding="utf-8")
        # §6.2: re-validate the curated import allowlist at runtime — the
        # draft-time check alone doesn't cover hand-edited or stale scripts.
        bad = disallowed_imports(source)
        if bad:
            emit("log", k="err",
                 text=f"import {', '.join(bad)} isn't allowed — steps may only import "
                      f"the Python stdlib and the curated packages (§6.2)")
            return 4
        code = compile(source, script, "exec")
        exec(code, g)  # noqa: S102 — this is the engine's job
        sys.stdout.flush()
        sys.stderr.flush()
        return 0
    except MissingSecret as e:
        emit("log", k="err", text=str(e))
        return 3
    except BaseException:  # noqa: BLE001
        for ln in traceback.format_exc().strip().splitlines():
            emit("log", k="err", text=ln)
        return 1


if __name__ == "__main__":
    sys.exit(main())
