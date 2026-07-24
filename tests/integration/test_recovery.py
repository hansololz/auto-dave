"""§15 integration: SIGKILL mid-execution → restart → §3 stale-executing repair."""
import json

import pytest

from .it_harness import create_auto, wait_for

pytestmark = pytest.mark.integration


def test_sigkill_mid_execution_repairs_to_interrupted(backend_factory):
    b1 = backend_factory()
    with b1.client() as c:
        a = create_auto(c, name="Sleeper", steps=[
            {"file": "01-sleep.py", "name": "Sleep", "desc": "hangs",
             "code": 'import time\nlog("sleeping")\ntime.sleep(120)\n'},
        ])
        exec_id = c.post(f"/automations/{a['id']}/execute", json={}).json()["execId"]
        wait_for(lambda: c.get(f"/executions/{exec_id}").json()["status"] == "executing",
                 30, "execution to go live")
        # Make sure the step subprocess actually started before the kill
        wait_for(lambda: any("sleeping" in ln["text"] for ln in
                             c.get(f"/executions/{exec_id}/logs",
                                   params={"step": 0, "attempt": 1}).json()["lines"]),
                 30, "step to log")
    b1.kill()

    b2 = backend_factory(home=b1.home)
    info = json.loads((b2.home / "backend.json").read_text())
    assert info["pid"] == b2.proc.pid  # fresh handshake, not the corpse's
    with b2.client() as c:
        e = c.get(f"/executions/{exec_id}").json()
        assert e["status"] == "interrupted"
        assert e["note"] == "backend restarted mid-execution"
        assert e["steps"][0]["status"] == "interrupted"
        row = next(x for x in c.get("/automations").json() if x["id"] == a["id"])
        assert row["lastStatus"] == "interrupted"
