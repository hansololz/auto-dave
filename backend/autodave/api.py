"""Backend API (§19): localhost JSON over HTTP + one WebSocket, bearer-token auth."""
from __future__ import annotations

import asyncio
import re
import secrets as pysecrets
import subprocess
import threading
import time
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import __version__, harness, keychain, paths
from . import drafting, packages as pkglib, schedule
from .drafting import draft_jobs
from .engine import Engine
from .events import hub
from .scheduler import fire_trigger
from .storage import size_label, store
from .testexec import test_execs

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


def _auto_json_locked(a: dict) -> dict:
    """Serialize an automation under store.lock — the only correct way to build
    a response payload from live state (auto_json reads fields the engine and
    scheduler mutate concurrently)."""
    with store.lock:
        return store.auto_json(a)


def _agent_or_404(agent_id: str) -> dict:
    for a in store.agents:
        if a["id"] == agent_id:
            return a
    raise HTTPException(404, "agent not found")


# The executions tree can be GBs across thousands of directories; the size
# label is display-only, so one walk per TTL window is plenty — and it must
# never run while holding store.lock (it would stall live log streaming).
_DATA_SIZE_TTL_S = 30
_data_size_cache: tuple[float, str] | None = None


def _data_size_label() -> str:
    global _data_size_cache
    now = time.monotonic()
    if _data_size_cache and now - _data_size_cache[0] < _DATA_SIZE_TTL_S:
        return _data_size_cache[1]
    p = store.executions_dir()
    total = sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.exists() else 0
    _data_size_cache = (now, size_label(total))
    return _data_size_cache[1]


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
    s["dataSize"] = _data_size_label()
    s["appPath"] = str(paths.app_support())
    return s


def _secrets_json() -> list[dict]:
    return [{"name": s["name"], "desc": s.get("desc") or "",
             "usedBy": ", ".join(store.secret_used_by(s["name"])) or "Not used yet"}
            for s in sorted(store.secrets, key=lambda s: s["name"])]


def _agent_grant(g: dict) -> dict:
    """§8 grants yaml entry: name, description, harness, model — the fields the
    drafting agent weighs when deciding which agents to use; ids stay internal."""
    e = {"name": g.get("name") or g.get("harness", "")}
    if g.get("desc"):
        e["description"] = g["desc"]
    e["harness"] = g.get("harness", "")
    e["model"] = g.get("model") or "harness default"
    return e


def _secret_grant(name: str) -> dict:
    """§8 grants yaml entry: name + description (omitted when empty)."""
    e = {"name": name}
    desc = next((s.get("desc") for s in store.secrets if s["name"] == name), "")
    if desc:
        e["description"] = desc
    return e


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
    settings = _settings_json()  # walks the executions tree — never under the lock
    with store.lock:
        return {
            "version": __version__,
            "autos": [store.auto_json(a) for a in store.autos.values()],
            "execs": sorted((store.exec_json(h) for h in store.execs.values()),
                            key=lambda e: e["startedMs"], reverse=True),
            "agents": _agents_json(),
            "secrets": _secrets_json(),
            "settings": settings,
            "pendingDraft": store.pending_draft_summary(),
        }


# ---------- automations ----------
@app.get("/automations", dependencies=[Depends(auth)])
def list_autos() -> list[dict]:
    with store.lock:
        return [store.auto_json(a) for a in store.autos.values()]


@app.get("/automations/{auto_id}", dependencies=[Depends(auth)])
def get_auto(auto_id: str) -> dict:
    return _auto_json_locked(_auto_or_404(auto_id))


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
    return _auto_json_locked(a)


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
            "params": d.get("params", []), "packages": d.get("packages", []),
            "steps": d.get("steps", []),
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
    # §4.4: Create consumes the pending create-mode slot — settled drafts are
    # never resurrected.
    store.delete_pending_draft()
    hub.publish("draft.changed")
    hub.publish("auto.changed", autoId=a["id"])
    return _auto_json_locked(a)


@app.post("/automations/{auto_id}/versions", dependencies=[Depends(auth)])
def save_version(auto_id: str, body: dict) -> dict:
    a = _auto_or_404(auto_id)
    d = body.get("draft") or {}
    if not d.get("steps"):
        raise HTTPException(422, "draft has no steps")
    # §4.3/§4.4: the draft's trigger list (merged in the editor) replaces the
    # automation's — validated like the PATCH, and before the version lands.
    triggers = None
    if "triggers" in d:
        triggers, err = schedule.normalize_triggers(d["triggers"])
        if err:
            raise HTTPException(422, err)
    n = store.save_new_version(a, _draft_to_version(d))
    patch = {k: body[k] for k in ("agentId", "stepAgents", "allowedSecrets", "name") if k in body}
    if triggers is not None:
        patch["triggers"] = triggers
    if patch:
        store.patch_automation(a, patch)
    store.delete_draft(a)
    hub.publish("auto.changed", autoId=auto_id)
    return {"version": n, "auto": _auto_json_locked(a)}


@app.put("/automations/{auto_id}/draft", dependencies=[Depends(auth)])
def put_draft(auto_id: str, body: dict) -> dict:
    a = _auto_or_404(auto_id)
    d = body.get("draft") or {}
    # §4.4: the draft snapshot carries the editor's grant selections and trigger
    # list as draft-only keys — never applied to the automation until saved.
    ver = _draft_to_version(d)
    ver["step_agents"] = d.get("stepAgents")
    ver["allowed_secrets"] = d.get("allowedSecrets")
    ver["triggers"] = d.get("triggers")
    store.save_draft(a, ver)
    hub.publish("auto.changed", autoId=auto_id)
    return {"ok": True}


@app.delete("/automations/{auto_id}/draft", dependencies=[Depends(auth)])
def del_draft(auto_id: str) -> dict:
    a = _auto_or_404(auto_id)
    store.delete_draft(a)
    hub.publish("auto.changed", autoId=auto_id)
    return {"ok": True}


# §4.4 pending create-mode slot (<root>/draft/) — one unsaved new automation.
@app.get("/draft", dependencies=[Depends(auth)])
def get_pending_draft() -> dict:
    return store.pending_draft_json()


@app.post("/draft/open", dependencies=[Depends(auth)])
def open_pending_draft() -> dict:
    store.open_pending_draft()
    return {"ok": True}


@app.put("/draft", dependencies=[Depends(auth)])
def put_pending_draft(body: dict) -> dict:
    d = body.get("draft") or {}
    ver = _draft_to_version(d)
    ver["step_agents"] = d.get("stepAgents")
    ver["allowed_secrets"] = d.get("allowedSecrets")
    # Triggers pass through unvalidated — Create normalizes them (§19).
    store.save_pending_draft(ver, name=d.get("name"), agent_id=body.get("agentId"),
                             triggers=d.get("triggers") or [])
    hub.publish("draft.changed")
    return {"ok": True}


@app.delete("/draft", dependencies=[Depends(auth)])
def del_pending_draft() -> dict:
    store.delete_pending_draft()
    hub.publish("draft.changed")
    return {"ok": True}


@app.post("/automations/{auto_id}/restore", dependencies=[Depends(auth)])
def restore(auto_id: str, body: dict) -> dict:
    a = _auto_or_404(auto_id)
    try:
        v = int(body.get("v", 0))
    except (TypeError, ValueError):
        raise HTTPException(422, "v must be an integer") from None
    if v not in a["versions"]:
        raise HTTPException(404, f"v{v} not found")
    n = store.restore_version(a, v)
    hub.publish("auto.changed", autoId=auto_id)
    return {"version": n, "auto": _auto_json_locked(a)}


@app.post("/automations/{auto_id}/execute", dependencies=[Depends(auth)])
def execute_auto(auto_id: str, body: dict | None = None) -> dict:
    a = _auto_or_404(auto_id)
    body = body or {}
    try:
        h = engine.start(a, body.get("trigger", "Manual"), version_label=body.get("version"))
    except LookupError as e:  # unknown version label — not a liveness conflict
        raise HTTPException(404, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e
    return {"execId": h["id"]}


@app.post("/app-started", dependencies=[Depends(auth)])
def app_started() -> dict:
    """§6 app-start firing: the Electron main process calls this once per app
    launch; every automation holding an enabled `app_start` trigger executes."""
    with store.lock:
        autos = list(store.autos.values())
    fired = 0
    for a in autos:
        t = next((t for t in a["triggers"]
                  if t["kind"] == "app_start" and not t["off"]), None)
        if t and fire_trigger(store, engine, a, t):
            fired += 1
    return {"fired": fired}


# ---------- tests (§11 Test — §19 POST /tests) ----------
@app.post("/tests", dependencies=[Depends(auth)])
def post_test(body: dict) -> dict:
    d = body.get("draft")
    if not d or not d.get("steps"):
        raise HTTPException(422, "draft with steps required")
    auto = None
    if body.get("autoId"):
        # A stale/unknown autoId must 404 — falling through to create mode
        # would wipe the unrelated pending slot's workspace/result dirs.
        auto = _auto_or_404(body["autoId"])
    # The agent serves the §8 issue-analysis call only — a test without any
    # agent still executes; a failure then opens with the raw error instead.
    aid = body.get("agentId") or next((a["id"] for a in store.agents if a.get("default")),
                                      store.agents[0]["id"] if store.agents else "")
    agent = next((a for a in store.agents if a["id"] == aid), None)
    enabled = body.get("enabledAgents")
    if enabled is None:
        enabled = auto["enabled_agents"] if auto else []
    allowed = body.get("allowedSecrets")
    if allowed is None:
        allowed = auto["allowed_secrets"] if auto else []
    test_id = test_execs.start(d, auto, agent, enabled, allowed, body.get("paramValues") or {})
    return {"testId": test_id}


@app.delete("/tests/{test_id}", dependencies=[Depends(auth)])
def cancel_test(test_id: str) -> dict:
    return {"ok": test_execs.cancel(test_id)}


# ---------- declared packages (§6.2 — §19 /packages/*) ----------
@app.post("/packages/check", dependencies=[Depends(auth)])
def packages_check(body: dict) -> dict:
    return {"packages": pkglib.check(body.get("packages") or [])}


@app.post("/packages/install", dependencies=[Depends(auth)])
def packages_install(body: dict) -> dict:
    # Blocking §6.2 ensure — FastAPI runs sync endpoints on a worker thread,
    # and the module lock serializes concurrent pip runs.
    return {"packages": pkglib.ensure(body.get("packages") or [])}


@app.post("/packages/outdated", dependencies=[Depends(auth)])
def packages_outdated(body: dict) -> dict:
    # §6.2 update check — read-only PyPI lookups; failures just omit `latest`.
    return {"packages": pkglib.outdated(body.get("packages") or [])}


@app.post("/packages/update", dependencies=[Depends(auth)])
def packages_update(body: dict) -> dict:
    """§6.2 update: `pip install --upgrade` in the shared directory — no
    manifest writes; manifests carry no version. Blocking like /install."""
    entries = body.get("packages") or []
    for e in entries:
        if not pkglib.PIP_NAME_RE.match(str(e.get("pip") or "").strip()):
            raise HTTPException(422, f"not a bare distribution name: {e.get('pip')!r}")
    return {"packages": pkglib.upgrade(entries)}


@app.post("/automations/{auto_id}/memory/clear", dependencies=[Depends(auth)])
def clear_memory(auto_id: str) -> dict:
    # §9.2 MEMORY card: "Clear memory" — next execution starts fresh.
    a = _auto_or_404(auto_id)
    store.snapshot_memory(a, "pre-clear")  # §6.3 — silently skipped when memory is empty or the toggle is off
    store.clear_memory(a)
    hub.publish("auto.changed", autoId=auto_id)
    return {"ok": True}


@app.post("/automations/{auto_id}/memory/snapshots", dependencies=[Depends(auth)])
def create_snapshot(auto_id: str, body: dict | None = None) -> dict:
    # §6.3 manual snapshot — 409 while live, 422 when memory is empty.
    a = _auto_or_404(auto_id)
    if a.get("_live"):
        raise HTTPException(409, "an execution is in progress")
    meta = store.snapshot_memory(a, "manual", name=((body or {}).get("name") or "").strip() or None)
    if meta is None:
        raise HTTPException(422, "memory is empty")
    hub.publish("auto.changed", autoId=auto_id)
    return {"snapshot": store.snapshot_json(meta)}


@app.patch("/automations/{auto_id}/memory/snapshots/{sid}", dependencies=[Depends(auth)])
def rename_snapshot(auto_id: str, sid: str, body: dict | None = None) -> dict:
    a = _auto_or_404(auto_id)
    meta = store.rename_snapshot(a, sid, (body or {}).get("name"))
    if meta is None:
        raise HTTPException(404, "snapshot not found")
    hub.publish("auto.changed", autoId=auto_id)
    return {"snapshot": store.snapshot_json(meta)}


@app.post("/automations/{auto_id}/memory/snapshots/{sid}/restore", dependencies=[Depends(auth)])
def restore_snapshot(auto_id: str, sid: str) -> dict:
    a = _auto_or_404(auto_id)
    if a.get("_live"):
        raise HTTPException(409, "an execution is in progress")
    if store.restore_snapshot(a, sid) is None:
        raise HTTPException(404, "snapshot not found")
    hub.publish("auto.changed", autoId=auto_id)
    return {"ok": True}


@app.delete("/automations/{auto_id}/memory/snapshots/{sid}", dependencies=[Depends(auth)])
def delete_snapshot(auto_id: str, sid: str) -> dict:
    a = _auto_or_404(auto_id)
    if not store.delete_snapshot(a, sid):
        raise HTTPException(404, "snapshot not found")
    hub.publish("auto.changed", autoId=auto_id)
    return {"ok": True}


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
    if enabled_ids is None:
        # §19: edit/sync fall back to the stored grants; create defaults to every
        # configured agent — the same all-enabled seed the Review page starts from.
        enabled_ids = auto["enabled_agents"] if auto else [a["id"] for a in store.agents]
    allowed = body.get("allowedSecrets")
    if allowed is None:
        allowed = auto["allowed_secrets"] if auto else []
    grants = {
        "agents": [_agent_grant(g) for g in store.agents if g["id"] in enabled_ids],
        "secrets": [_secret_grant(n) for n in allowed],
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
    with store.lock:
        hs = list(store.execs.values())
        if auto:
            hs = [h for h in hs if h["auto_id"] == auto]
        if status:
            hs = [h for h in hs if h["status"] == status]
        return sorted((store.exec_json(h) for h in hs), key=lambda e: e["startedMs"], reverse=True)


@app.get("/executions/{exec_id}", dependencies=[Depends(auth)])
def get_exec(exec_id: str) -> dict:
    with store.lock:
        h = store.exec_full(exec_id)
        if not h:
            raise HTTPException(404, "execution not found")
        return store.exec_json(h, full=True)


@app.get("/executions/{exec_id}/logs", dependencies=[Depends(auth)])
def get_exec_logs(exec_id: str, step: int | None = None, attempt: int | None = None) -> dict:
    """§19: lazy per-step-attempt log — no params selects the execution log."""
    if exec_id not in store.execs:
        raise HTTPException(404, "execution not found")
    lines = store.read_log(exec_id, step, attempt)
    return {"lines": [{"t": l.get("t", ""), "k": l.get("k", "out"),
                       "seq": l.get("seq", 0), "text": l.get("text", "")} for l in lines]}


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


@app.post("/executions/{exec_id}/retry", dependencies=[Depends(auth)])
def retry_exec(exec_id: str) -> dict:
    h = store.execs.get(exec_id)
    if not h:
        raise HTTPException(404, "execution not found")
    a = _auto_or_404(h["auto_id"])
    try:
        h2 = engine.retry(a, h)
    except (RuntimeError, LookupError) as e:
        # §7: retry answers 409 while live, when the version no longer
        # resolves, or when a re-saved draft's steps drifted from the record.
        raise HTTPException(409, str(e)) from e
    return {"execId": h2["id"]}


@app.post("/executions/{exec_id}/skip-step", dependencies=[Depends(auth)])
def skip_step(exec_id: str, body: dict) -> dict:
    if exec_id not in store.execs:
        raise HTTPException(404, "execution not found")
    index = body.get("index")
    if not isinstance(index, int):
        raise HTTPException(422, "index required")
    if not engine.skip_step(exec_id, index):
        raise HTTPException(409, "that step isn't executing right now")
    return {"ok": True}


# ---------- agents ----------
HARNESSES = ("Claude Code", "Gemini CLI", "Codex", "OpenCode", "Ollama")


@app.get("/agents", dependencies=[Depends(auth)])
def list_agents() -> list[dict]:
    with store.lock:
        return _agents_json()


@app.post("/agents", dependencies=[Depends(auth)])
def add_agent(body: dict) -> dict:
    harness_name = body.get("harness")
    if harness_name not in HARNESSES:
        raise HTTPException(422, "unknown harness")
    mode = body.get("mode", "default")
    if mode not in ("default", "ollama"):
        raise HTTPException(422, "mode must be default | ollama")
    # §4.7: model is null unless mode is ollama — a null model means the
    # harness uses whatever it is already configured with.
    model = (body.get("model") or None) if mode == "ollama" else None
    if mode == "ollama" and not model:
        raise HTTPException(422, "Ollama mode needs a model")
    import uuid

    with store.lock:
        ag = {"id": str(uuid.uuid4()), "name": body.get("name") or None, "desc": body.get("desc") or "",
              "harness": harness_name, "mode": mode, "model": model, "default": not store.agents}
        store.agents.append(ag)
        store.save_agents()
    hub.publish("agents.changed")
    return ag


@app.patch("/agents/{agent_id}", dependencies=[Depends(auth)])
def patch_agent(agent_id: str, body: dict) -> dict:
    # Same validation as POST — a PATCH must not be able to create an agent
    # shape POST rejects (e.g. mode ollama with no model, §4.7).
    if "harness" in body and body["harness"] not in HARNESSES:
        raise HTTPException(422, "unknown harness")
    if "mode" in body and body["mode"] not in ("default", "ollama"):
        raise HTTPException(422, "mode must be default | ollama")
    with store.lock:
        ag = _agent_or_404(agent_id)
        mode = body.get("mode", ag.get("mode", "default"))
        model = body["model"] if "model" in body else ag.get("model")
        if mode == "ollama" and not model:
            raise HTTPException(422, "Ollama mode needs a model")
        if body.get("default"):
            for g in store.agents:
                g["default"] = g["id"] == agent_id
        if "harness" in body:
            ag["harness"] = body["harness"]
        for k in ("name", "model", "mode", "desc"):
            if k in body:
                ag[k] = body[k]
        if ag.get("mode") != "ollama":
            ag["model"] = None
        store.save_agents()
    hub.publish("agents.changed")
    return ag


@app.delete("/agents/{agent_id}", dependencies=[Depends(auth)])
def delete_agent(agent_id: str) -> dict:
    with store.lock:
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
    return {"status": "ready" if harness.check_ready(ag["harness"], ag.get("model"))
            else "needs-setup"}


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
    with store.lock:
        existing = next((s for s in store.secrets if s["name"] == name), None)
        # §4.8: a new secret needs a value; a blank value on an existing one keeps
        # the stored value (description-only update).
        if not value and existing is None:
            raise HTTPException(422, "value required")
    if value:
        # Keychain IPC can block for seconds (locked keychain, consent prompt) —
        # never hold store.lock across it; the engine would stall mid-execution.
        keychain.set_secret(name, value)
    with store.lock:
        existing = next((s for s in store.secrets if s["name"] == name), None)
        if existing is None:
            existing = {"name": name, "desc": ""}
            store.secrets.append(existing)
        if "desc" in body:
            existing["desc"] = body.get("desc") or ""
        store.save_secrets()
    hub.publish("secrets.changed")
    return {"ok": True}


@app.delete("/secrets/{name}", dependencies=[Depends(auth)])
def delete_secret(name: str) -> dict:
    keychain.delete_secret(name)  # Keychain IPC — outside the lock (see put_secret)
    with store.lock:
        store.secrets = [s for s in store.secrets if s["name"] != name]
        store.save_secrets()
    hub.publish("secrets.changed")
    return {"ok": True}


# ---------- settings ----------
@app.get("/settings", dependencies=[Depends(auth)])
def get_settings() -> dict:
    return _settings_json()


@app.patch("/settings", dependencies=[Depends(auth)])
def patch_settings(body: dict) -> dict:
    with store.lock:
        for k in ("login", "mbIcon", "notif", "days", "keepForever", "devMode"):
            if k in body:
                store.settings[k] = body[k]
        store.save_settings()
    hub.publish("settings.changed")
    return _settings_json()


@app.post("/settings/data-path", dependencies=[Depends(auth)])
def set_data_path(body: dict) -> dict:
    global _data_size_cache
    raw = str(body.get("path", "")).strip()
    if not raw:
        raise HTTPException(422, "path required")
    new_root = Path(raw).expanduser()
    target = new_root if new_root.name == "executions" else new_root / "executions"
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(422, f"can't create that directory: {e}") from e
    # Nothing moves: execution state lives in the executions dir, so switching
    # the path just closes the old DB and reloads from the new location. The
    # whole swap holds the lock — an engine thread finishing mid-swap would
    # otherwise hit a closed DB and die with the execution stuck "executing" —
    # and is refused while an execution is live (it writes to the old dir).
    with store.lock:
        if any(h["status"] == "executing" for h in store.execs.values()):
            raise HTTPException(409, "an execution is in progress — try again when it finishes")
        store.close_exec_db()
        store.settings["dataPath"] = str(target)
        store.save_settings()
        store.load_all()
        # The new location may hold records a crashed backend left "executing" —
        # repair them here too, or the automation would be wedged in 409s.
        _repair_stale_executing()
    _data_size_cache = None
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
            await sock.send_json(await q.get())
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        hub.unsubscribe(q)


def _repair_stale_executing() -> None:
    """§3: a record can only be 'executing' while an engine thread owns it —
    anything else (backend restart, a data-path switch onto a crashed tree) is
    marked interrupted. Callers hold store.lock (RLock, re-entry is fine)."""
    with store.lock:
        for h in list(store.execs.values()):
            if h["status"] == "executing" and not engine.is_live(h["id"]):
                full = store.exec_full(h["id"]) or {**h, "steps": [], "redacted": [], "params": []}
                full["status"] = "interrupted"
                full["note"] = full["note"] or "backend restarted mid-execution"
                for s in full["steps"]:
                    if s["status"] == "executing":
                        s["status"] = "interrupted"
                        for a in s.get("attempts", []):
                            if a["status"] == "executing":
                                a["status"] = "interrupted"
                store.execs[full["id"]] = full
                store.update_execution(full)
        store._refresh_exec_derived()


@app.on_event("startup")
async def _bind_loop() -> None:
    hub.bind_loop(asyncio.get_running_loop())
    _repair_stale_executing()
    hub.publish("auto.changed")
