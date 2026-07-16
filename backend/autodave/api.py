"""Backend API (§19): localhost JSON over HTTP + one WebSocket, bearer-token auth."""
from __future__ import annotations

import asyncio
import re
import secrets as pysecrets
import subprocess
import threading
from datetime import datetime
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import __version__, harness, keychain, paths
from . import drafting, schedule
from .drafting import draft_jobs
from .engine import Engine
from .events import hub
from .storage import SECRET_REF_RE, Store, param_default, resolve_param_value, store

AUTH_TOKEN = pysecrets.token_hex(24)
SECRET_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")

engine = Engine(store)
_bearer = HTTPBearer(auto_error=False)


def auth(cred: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> None:
    if cred is None or cred.credentials != AUTH_TOKEN:
        raise HTTPException(401, "bad token")


app = FastAPI(title="Auto Dave backend", version=__version__)

# The Electron renderer (vite dev server or file://) calls us cross-origin; the
# bearer token is the actual gate — the service binds to 127.0.0.1 only.
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def _auto_or_404(auto_id: str) -> dict:
    a = store.autos.get(auto_id)
    if not a:
        raise HTTPException(404, "automation not found")
    return a


def _agent_or_404(agent_id: str) -> dict:
    for a in store.agents:
        if a["id"] == agent_id:
            return a
    raise HTTPException(404, "agent not found")


def _dir_size_label(p: Path) -> str:
    total = sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.exists() else 0
    if total < 1024 * 1024:
        return f"{total / 1024:.0f} KB"
    if total < 1024 * 1024 * 1024:
        return f"{total / 1024 / 1024:.1f} MB"
    return f"{total / 1024 / 1024 / 1024:.1f} GB"


def _agents_json() -> list[dict]:
    out = []
    for ag in store.agents:
        used = [a["name"] for a in store.autos.values()
                if a["agent_id"] == ag["id"] or ag["id"] in a["enabled_agents"]]
        out.append({**ag, "usedBy": used})
    return out


def _settings_json() -> dict:
    s = dict(store.settings)
    s["dataPath"] = str(store.data_path())
    s["dataSize"] = _dir_size_label(store.executions_dir())
    s["appPath"] = str(paths.app_support())
    return s


def _secrets_json() -> list[dict]:
    return [{"name": n, "usedBy": ", ".join(store.secret_used_by(n)) or "Not used yet"}
            for n in sorted(store.secret_names)]


# ---------- health / state ----------
@app.get("/health")
def health() -> dict:
    return {"version": __version__, "app": "Auto Dave"}


@app.get("/instructions", dependencies=[Depends(auth)])
def instructions() -> dict:
    """§8 instruction files for the create/edit page, verbatim:
    framework-instructions.md + default-build-instructions.md."""
    return {"framework": drafting.CONTRACT_PREAMBLE,
            "defaultBuild": drafting.DEFAULT_INSTRUCTIONS}


@app.get("/state", dependencies=[Depends(auth)])
def state() -> dict:
    with store.lock:
        return {
            "version": __version__,
            "autos": [store.auto_json(a) for a in store.autos.values()],
            "execs": sorted((store.exec_json(h) for h in store.execs.values()),
                            key=lambda e: e["startedMs"], reverse=True),
            "agents": _agents_json(),
            "secrets": _secrets_json(),
            "settings": _settings_json(),
        }


# ---------- automations ----------
@app.get("/automations", dependencies=[Depends(auth)])
def list_autos() -> list[dict]:
    return [store.auto_json(a) for a in store.autos.values()]


@app.get("/automations/{auto_id}", dependencies=[Depends(auth)])
def get_auto(auto_id: str) -> dict:
    return store.auto_json(_auto_or_404(auto_id))


@app.patch("/automations/{auto_id}", dependencies=[Depends(auth)])
def patch_auto(auto_id: str, patch: dict) -> dict:
    a = _auto_or_404(auto_id)
    if "triggers" in patch:
        # §19: whole-list replace; message kinds / bad expressions / past times → 422.
        norm, err = schedule.normalize_triggers(patch["triggers"])
        if err:
            raise HTTPException(422, err)
        patch = {**patch, "triggers": norm}
    store.patch_automation(a, patch)
    hub.publish("auto.changed", autoId=auto_id)
    return store.auto_json(a)


@app.delete("/automations/{auto_id}", dependencies=[Depends(auth)])
def delete_auto(auto_id: str) -> dict:
    a = _auto_or_404(auto_id)
    if a.get("_live"):
        engine.cancel(a["_live"])
    store.delete_automation(a)
    hub.publish("auto.changed")
    return {"ok": True}


def _draft_to_version(d: dict) -> dict:
    return {"desc": d.get("desc", ""), "note": d.get("note", ""),
            "params": d.get("params", []), "steps": d.get("steps", []),
            "spec": d.get("spec") or [], "instr": d.get("instr")}


@app.post("/automations", dependencies=[Depends(auth)])
def create_auto(body: dict) -> dict:
    d = body.get("draft") or {}
    if not d.get("steps"):
        raise HTTPException(422, "draft has no steps")
    triggers, err = schedule.normalize_triggers(d.get("triggers") or [])
    if err:
        raise HTTPException(422, err)
    a = store.create_automation(
        _draft_to_version(d),
        name=body.get("name") or d.get("name") or "New automation",
        agent_id=body.get("agentId"),
        triggers=triggers,
        enabled_agents=body.get("stepAgents"),
        allowed_secrets=body.get("allowedSecrets"),
    )
    hub.publish("auto.changed", autoId=a["id"])
    return store.auto_json(a)


@app.post("/automations/{auto_id}/versions", dependencies=[Depends(auth)])
def save_version(auto_id: str, body: dict) -> dict:
    a = _auto_or_404(auto_id)
    d = body.get("draft") or {}
    if not d.get("steps"):
        raise HTTPException(422, "draft has no steps")
    n = store.save_new_version(a, _draft_to_version(d))
    patch = {k: body[k] for k in ("agentId", "stepAgents", "allowedSecrets", "name") if k in body}
    if patch:
        store.patch_automation(a, patch)
    store.delete_draft(a)
    hub.publish("auto.changed", autoId=auto_id)
    return {"version": n, "auto": store.auto_json(a)}


@app.put("/automations/{auto_id}/draft", dependencies=[Depends(auth)])
def put_draft(auto_id: str, body: dict) -> dict:
    a = _auto_or_404(auto_id)
    store.save_draft(a, _draft_to_version(body.get("draft") or {}))
    hub.publish("auto.changed", autoId=auto_id)
    return {"ok": True}


@app.delete("/automations/{auto_id}/draft", dependencies=[Depends(auth)])
def del_draft(auto_id: str) -> dict:
    a = _auto_or_404(auto_id)
    store.delete_draft(a)
    hub.publish("auto.changed", autoId=auto_id)
    return {"ok": True}


@app.post("/automations/{auto_id}/restore", dependencies=[Depends(auth)])
def restore(auto_id: str, body: dict) -> dict:
    a = _auto_or_404(auto_id)
    v = int(body.get("v", 0))
    if v not in a["versions"]:
        raise HTTPException(404, f"v{v} not found")
    n = store.restore_version(a, v)
    hub.publish("auto.changed", autoId=auto_id)
    return {"version": n, "auto": store.auto_json(a)}


@app.post("/automations/{auto_id}/execute", dependencies=[Depends(auth)])
def execute_auto(auto_id: str, body: dict | None = None) -> dict:
    a = _auto_or_404(auto_id)
    body = body or {}
    try:
        h = engine.start(a, body.get("trigger", "Manual"), version_label=body.get("version"))
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e
    return {"execId": h["id"]}


# ---------- review checks (§11 decided semantics) ----------
@app.post("/automations/{auto_id}/checks", dependencies=[Depends(auth)])
def checks(auto_id: str, body: dict | None = None) -> dict:
    a = _auto_or_404(auto_id)
    body = body or {}
    d = body.get("draft")
    ver = {"params": d["params"], "steps": d["steps"]} if d else a["versions"][a["current_version"]]
    # In-editor grants override the saved ones when present (unsaved Review-screen state).
    allowed_secrets = body["allowedSecrets"] if "allowedSecrets" in body else a["allowed_secrets"]
    enabled_agents = body["enabledAgents"] if "enabledAgents" in body else a["enabled_agents"]
    _start_checks(a, auto_id, ver, allowed_secrets, enabled_agents)
    return {"ok": True}


@app.post("/automations/{auto_id}/memory/clear", dependencies=[Depends(auth)])
def clear_memory(auto_id: str) -> dict:
    # §9.2 MEMORY card: "Clear memory" — next execution starts fresh.
    a = _auto_or_404(auto_id)
    store.clear_memory(a)
    hub.publish("auto.changed", autoId=auto_id)
    return {"ok": True}


@app.post("/checks", dependencies=[Depends(auth)])
def checks_draft(body: dict) -> dict:
    # §19 create-mode checks: no saved automation yet — checks evaluate the sent draft.
    d = body.get("draft")
    if not d:
        raise HTTPException(422, "draft required")
    ver = {"params": d.get("params", []), "steps": d.get("steps", [])}
    _start_checks(None, None, ver, body.get("allowedSecrets", []), body.get("enabledAgents", []))
    return {"ok": True}


def _start_checks(a: dict | None, auto_id: str | None, ver: dict,
                  allowed_secrets: list, enabled_agents: list) -> None:
    def lines() -> None:
        import urllib.request

        def say(kind: str, text: str) -> None:
            hub.publish("checks.line", autoId=auto_id, kind=kind, text=text)

        def probe(u: str) -> tuple[str, bool]:
            try:
                req = urllib.request.Request(u, method="HEAD", headers={"User-Agent": "AutoDave/1.0"})
                urllib.request.urlopen(req, timeout=5)
                return u, True
            except Exception:  # noqa: BLE001
                return u, False

        for p in ver.get("params", []):
            v = resolve_param_value(p, a["param_values"] if a else {})
            label = p.get("label", p["name"])
            if p["kind"] == "list" and p.get("validate"):
                urls = [l for l in v if re.match(r"^https?://\S+\.\S+", l.strip())]
                bad = [l for l in v if l.strip() and not re.match(r"^https?://\S+\.\S+", l.strip())]
                say("ok" if not bad else "warn",
                    f"{label}: {len(urls)} valid links" + (f" · {len(bad)} need attention" if bad else ""))
                # §11: HEAD probe every valid URL (5 s timeout each), in parallel.
                if urls:
                    from concurrent.futures import ThreadPoolExecutor

                    with ThreadPoolExecutor(max_workers=min(8, len(urls))) as pool:
                        for u, ok in pool.map(probe, urls):
                            say("ok" if ok else "warn",
                                (f"reachable — {u}" if ok else f"didn't answer — {u}"))
            elif p["kind"] == "number":
                mn = p.get("min", 0)
                try:
                    good = float(v) >= float(mn)
                except (TypeError, ValueError):
                    good = False
                say("ok" if good else "warn",
                    f"{label}: {v}" + ("" if good else f" needs attention — expected a number of at least {mn}"))
            elif p["kind"] == "kv":
                entries = v if isinstance(v, list) else []
                say("ok", f"{label}: {len(entries)} " + ("entry" if len(entries) == 1 else "entries"))
            else:
                say("ok", f"{label}: {v if v not in ('', []) else 'default'}")
        refs = sorted({m for s in ver.get("steps", []) for m in SECRET_REF_RE.findall(s.get("code", ""))})
        for name in refs:
            if name not in allowed_secrets:
                say("err", f"secret {name} isn't allowed for this automation")
            elif keychain.get_secret(name) is None:
                say("err", f"secret {name} isn't in your Keychain")
            else:
                say("ok", f"secret {name} is in your Keychain and allowed")
        agents = {g["id"] for g in store.agents}
        for i, s in enumerate(ver.get("steps", []), 1):
            if s.get("agent"):
                ok = any(aid in agents for aid in enabled_agents)
                say("ok" if ok else "err",
                    f"step {i} makes an agent call — " + ("an enabled agent is ready" if ok else "no agent is enabled"))
        if a is not None:
            mem = store.memory_stats(a)
            say("ok", f"memory: {mem['size']} · {mem['updated']}")
        else:
            say("ok", "memory: empty — new automation")
        say("ok", "notification plan: " + ("after every execution" if store.settings.get("notif") == "all"
                                           else "only when something needs attention"))
        hub.publish("checks.done", autoId=auto_id)

    threading.Thread(target=lines, daemon=True).start()


# ---------- drafts ----------
@app.post("/drafts", dependencies=[Depends(auth)])
def post_draft(body: dict) -> dict:
    mode = body.get("mode")
    if mode not in ("create", "edit", "sync"):
        raise HTTPException(422, "mode must be create | edit | sync")
    agent = _agent_or_404(body.get("agentId") or
                          next((a["id"] for a in store.agents if a.get("default")),
                               store.agents[0]["id"] if store.agents else ""))
    auto = store.autos.get(body.get("autoId", "")) if body.get("autoId") else None
    current = body.get("current")
    if auto and current is None:
        current = auto["versions"][auto["current_version"]]
    # §19: an explicit `spec` in the body wins — sync/edit regenerate against the
    # PROVIDED spec (§8), e.g. the in-editor draft, not the stored version's spec.
    if body.get("spec") is not None:
        current = dict(current or {})
        current["spec"] = body["spec"]
    if mode == "create" and not (current or {}).get("instr"):
        # §8: new automations draft against the default best-practice build
        # instructions; the draft payload carries them back to pre-fill Review.
        current = dict(current or {})
        current["instr"] = drafting.DEFAULT_INSTRUCTIONS
    # §8/§19: in-editor grant arrays in the body win over the stored automation's —
    # the editor's live toggles are the truth while a draft is being worked on.
    enabled_ids = body.get("enabledAgents")
    if enabled_ids is None and auto:
        enabled_ids = auto["enabled_agents"]
    allowed = body.get("allowedSecrets")
    if allowed is None:
        allowed = auto["allowed_secrets"] if auto else []
    grants = {
        # §8: grants context carries agent NAMES — ids are meaningless to the drafting agent.
        "agents": [g.get("name") or g.get("harness", "") for g in store.agents
                   if g["id"] in enabled_ids] if enabled_ids is not None
                  else [agent.get("name") or agent.get("harness", "")],
        "secrets": allowed,
    }
    job_id = draft_jobs.start(mode, agent, body.get("text"), current, grants)
    return {"jobId": job_id}


@app.get("/drafts/{job_id}", dependencies=[Depends(auth)])
def get_draft(job_id: str) -> dict:
    j = draft_jobs.get(job_id)
    if not j:
        raise HTTPException(404, "job not found")
    return j


@app.delete("/drafts/{job_id}", dependencies=[Depends(auth)])
def cancel_draft(job_id: str) -> dict:
    return {"ok": draft_jobs.cancel(job_id)}


# ---------- executions ----------
@app.get("/executions", dependencies=[Depends(auth)])
def list_execs(auto: str | None = None, status: str | None = None) -> list[dict]:
    hs = list(store.execs.values())
    if auto:
        hs = [h for h in hs if h["auto_id"] == auto]
    if status:
        hs = [h for h in hs if h["status"] == status]
    return sorted((store.exec_json(h) for h in hs), key=lambda e: e["startedMs"], reverse=True)


@app.get("/executions/{exec_id}", dependencies=[Depends(auth)])
def get_exec(exec_id: str) -> dict:
    h = store.execs.get(exec_id)
    if not h:
        raise HTTPException(404, "execution not found")
    return store.exec_json(h, full=True)


@app.get("/executions/{exec_id}/result/{name}", dependencies=[Depends(auth)])
def get_result_file(exec_id: str, name: str):
    """§4.5: raw result-dir file (result.md, result.html, images) for the §7 file views."""
    if exec_id not in store.execs:
        raise HTTPException(404, "execution not found")
    d = (store.exec_dir(exec_id) / "result").resolve()
    f = (d / name).resolve()
    if f.parent != d or not f.is_file():
        raise HTTPException(404, "file not found")
    from fastapi.responses import FileResponse

    return FileResponse(f)


@app.post("/executions/{exec_id}/cancel", dependencies=[Depends(auth)])
def cancel_exec(exec_id: str) -> dict:
    return {"ok": engine.cancel(exec_id)}


@app.post("/executions/{exec_id}/reexecute", dependencies=[Depends(auth)])
def reexecute_exec(exec_id: str) -> dict:
    h = store.execs.get(exec_id)
    if not h:
        raise HTTPException(404, "execution not found")
    a = _auto_or_404(h["auto_id"])
    try:
        h2 = engine.reexecute_from_failed(a, h)
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e
    return {"execId": h2["id"]}


# ---------- agents ----------
@app.get("/agents", dependencies=[Depends(auth)])
def list_agents() -> list[dict]:
    return _agents_json()


@app.post("/agents", dependencies=[Depends(auth)])
def add_agent(body: dict) -> dict:
    harness_name = body.get("harness")
    if harness_name not in ("Claude Code", "Gemini CLI", "Codex", "OpenCode", "Ollama"):
        raise HTTPException(422, "unknown harness")
    mode = body.get("mode", "default")
    model = body.get("model") or harness.HARNESS_DEFAULT_MODEL.get(harness_name, "Configured default")
    if mode == "ollama" and not body.get("model"):
        raise HTTPException(422, "Ollama mode needs a model")
    import uuid

    ag = {"id": str(uuid.uuid4()), "name": body.get("name") or None, "desc": body.get("desc") or "",
          "harness": harness_name, "mode": mode, "model": model, "default": not store.agents}
    store.agents.append(ag)
    store.save_agents()
    hub.publish("agents.changed")
    return ag


@app.patch("/agents/{agent_id}", dependencies=[Depends(auth)])
def patch_agent(agent_id: str, body: dict) -> dict:
    ag = _agent_or_404(agent_id)
    if body.get("default"):
        for g in store.agents:
            g["default"] = g["id"] == agent_id
    if "harness" in body:
        if body["harness"] not in ("Claude Code", "Gemini CLI", "Codex", "OpenCode", "Ollama"):
            raise HTTPException(422, "unknown harness")
        ag["harness"] = body["harness"]
    for k in ("name", "model", "mode", "desc"):
        if k in body:
            ag[k] = body[k]
    store.save_agents()
    hub.publish("agents.changed")
    return ag


@app.delete("/agents/{agent_id}", dependencies=[Depends(auth)])
def delete_agent(agent_id: str) -> dict:
    ag = _agent_or_404(agent_id)
    store.agents = [g for g in store.agents if g["id"] != agent_id]
    # §4.7: reassign the default
    if ag.get("default") and store.agents:
        store.agents[0]["default"] = True
    for a in store.autos.values():
        changed = False
        if a["agent_id"] == agent_id:
            a["agent_id"] = next((g["id"] for g in store.agents if g.get("default")), None)
            changed = True
        if agent_id in a["enabled_agents"]:
            a["enabled_agents"] = [x for x in a["enabled_agents"] if x != agent_id]
            changed = True
        if changed:
            store.patch_automation(a, {})
    store.save_agents()
    hub.publish("agents.changed")
    hub.publish("auto.changed")
    return {"ok": True}


@app.post("/agents/{agent_id}/check", dependencies=[Depends(auth)])
def check_agent(agent_id: str) -> dict:
    ag = _agent_or_404(agent_id)
    return {"status": "ready" if harness.check_ready(ag["harness"]) else "needs-setup"}


@app.get("/agents/detect", dependencies=[Depends(auth)])
def detect_agents() -> list[dict]:
    return harness.detect()


@app.get("/ollama/status", dependencies=[Depends(auth)])
def ollama_status() -> dict:
    return harness.ollama_status()


@app.post("/ollama/pull", dependencies=[Depends(auth)])
def ollama_pull(body: dict) -> dict:
    model = body.get("model")
    if not model:
        raise HTTPException(422, "model required")

    def pull() -> None:
        try:
            proc = subprocess.Popen([harness.ollama_bin() or "ollama", "pull", model], stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True)
            for line in proc.stdout:  # type: ignore[union-attr]
                hub.publish("ollama.pull", model=model, line=line.strip(), done=False)
            proc.wait()
            hub.publish("ollama.pull", model=model, line="", done=True, ok=proc.returncode == 0)
        except FileNotFoundError:
            hub.publish("ollama.pull", model=model, line="ollama isn't installed", done=True, ok=False)
        hub.publish("agents.changed")

    threading.Thread(target=pull, daemon=True).start()
    return {"ok": True}


# ---------- secrets ----------
@app.get("/secrets", dependencies=[Depends(auth)])
def list_secrets() -> list[dict]:
    return _secrets_json()


@app.put("/secrets/{name}", dependencies=[Depends(auth)])
def put_secret(name: str, body: dict) -> dict:
    if not SECRET_NAME_RE.match(name):
        raise HTTPException(422, "secret names must match [A-Z][A-Z0-9_]* — "
                                 "uppercase letters, digits and underscores, starting with a letter")
    value = body.get("value", "")
    if not value:
        raise HTTPException(422, "value required")
    keychain.set_secret(name, value)
    if name not in store.secret_names:
        store.secret_names.append(name)
        store.save_secret_names()
    hub.publish("secrets.changed")
    return {"ok": True}


@app.delete("/secrets/{name}", dependencies=[Depends(auth)])
def delete_secret(name: str) -> dict:
    keychain.delete_secret(name)
    if name in store.secret_names:
        store.secret_names.remove(name)
        store.save_secret_names()
    hub.publish("secrets.changed")
    return {"ok": True}


# ---------- settings ----------
@app.get("/settings", dependencies=[Depends(auth)])
def get_settings() -> dict:
    return _settings_json()


@app.patch("/settings", dependencies=[Depends(auth)])
def patch_settings(body: dict) -> dict:
    for k in ("login", "mbIcon", "notif", "days", "keepForever", "devMode"):
        if k in body:
            store.settings[k] = body[k]
    store.save_settings()
    hub.publish("settings.changed")
    return _settings_json()


@app.post("/settings/data-path", dependencies=[Depends(auth)])
def set_data_path(body: dict) -> dict:
    raw = str(body.get("path", "")).strip()
    if not raw:
        raise HTTPException(422, "path required")
    new_root = Path(raw).expanduser()
    target = new_root if new_root.name == "executions" else new_root / "executions"
    target.mkdir(parents=True, exist_ok=True)
    # Nothing moves: execution state lives in the executions dir, so switching
    # the path just closes the old DB and reloads from the new location.
    store.close_exec_db()
    store.settings["dataPath"] = str(target)
    store.save_settings()
    store.load_all()
    hub.publish("settings.changed")
    hub.publish("auto.changed")
    return _settings_json()


# ---------- websocket ----------
@app.websocket("/ws")
async def ws(sock: WebSocket, token: str = Query("")) -> None:
    if token != AUTH_TOKEN:
        await sock.close(code=4401)
        return
    await sock.accept()
    q = hub.subscribe()
    try:
        while True:
            msg = await q.get()
            msg.pop("exec_", None)
            await sock.send_json(msg)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        hub.unsubscribe(q)


@app.on_event("startup")
async def _bind_loop() -> None:
    hub.bind_loop(asyncio.get_running_loop())
    # §3: never resume as 'executing' after a restart — mark stale records interrupted.
    with store.lock:
        for h in store.execs.values():
            if h["status"] == "executing" and not engine.is_live(h["id"]):
                h["status"] = "interrupted"
                h["note"] = h["note"] or "backend restarted mid-execution"
                for s in h["steps"]:
                    if s["status"] in ("executing", "queued"):
                        s["status"] = "interrupted" if s["status"] == "executing" else "queued"
                store.update_execution(h)
        store._refresh_exec_derived()
    hub.publish("auto.changed")


def make_datetime_now() -> datetime:  # test seam
    return datetime.now()
