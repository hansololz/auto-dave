"""§15 integration: real backend subprocess, real HTTP and WebSocket."""
import json
import stat

import pytest
from websockets.sync.client import connect

from .it_harness import create_auto, wait_for, wait_status

pytestmark = pytest.mark.integration


def test_boot_handshake_and_auth(backend, client):
    """§3: socket bound before backend.json publishes; token gates everything."""
    bj = backend.home / "backend.json"
    info = json.loads(bj.read_text())
    assert info["port"] == backend.port
    assert info["pid"] == backend.proc.pid
    assert info["version"]
    assert stat.S_IMODE(bj.stat().st_mode) == 0o600
    assert client.get("/health").status_code == 200
    import httpx

    with httpx.Client(base_url=backend.base) as anon:
        assert anon.get("/health").status_code == 200  # health is open
        assert anon.get("/state").status_code == 401
        bad = anon.get("/state", headers={"Authorization": "Bearer nope"})
        assert bad.status_code == 401


def test_execution_lifecycle_over_http(backend, client):
    a = create_auto(client)
    r = client.post(f"/automations/{a['id']}/execute", json={})
    assert r.status_code == 200
    exec_id = r.json()["execId"]
    e = wait_status(client, exec_id)
    assert e["status"] == "succeeded"
    assert e["result"]["chip"] == "All good"
    assert [s["status"] for s in e["steps"]] == ["succeeded", "succeeded"]
    # §5: logs never inline — the lazy endpoint serves them per step/attempt
    assert "logs" not in e["steps"][0]
    lines = client.get(f"/executions/{exec_id}/logs",
                       params={"step": 0, "attempt": 1}).json()["lines"]
    assert any("integration says hi" in ln["text"] for ln in lines)
    row = next(x for x in client.get("/automations").json() if x["id"] == a["id"])
    assert row["lastStatus"] == "succeeded"
    assert row["resultChip"] == "All good"


def test_ws_streams_execution_events(backend, client):
    a = create_auto(client, name="WS watched")
    events = []
    with connect(f"ws://127.0.0.1:{backend.port}/ws?token={backend.token}") as ws:
        exec_id = client.post(f"/automations/{a['id']}/execute", json={}).json()["execId"]

        def pump():
            msg = json.loads(ws.recv(timeout=30))
            events.append(msg)
            return msg["ev"] == "exec.finished" and msg.get("execId") == exec_id

        wait_for(pump, 60, "exec.finished on the WebSocket")
    kinds = [m["ev"] for m in events]
    assert kinds.index("exec.started") < kinds.index("exec.finished")
    finished = events[-1]
    assert finished["exec_json"]["status"] == "succeeded"
    assert finished["auto_json"]["lastStatus"] == "succeeded"
    # §5 log lines stream with per-file monotonic seq
    logs = [m for m in events if m["ev"] == "exec.log"]
    assert logs
    for step_key in {(m["stepIndex"], m.get("attempt")) for m in logs}:
        seqs = [m["line"]["seq"] for m in logs
                if (m["stepIndex"], m.get("attempt")) == step_key]
        assert seqs == sorted(seqs)


def test_ws_rejects_bad_token_over_real_socket(backend):
    with pytest.raises(Exception):
        with connect(f"ws://127.0.0.1:{backend.port}/ws?token=wrong") as ws:
            ws.recv(timeout=5)
