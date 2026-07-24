"""§15 integration: the real scheduler thread fires a one-shot and consumes it."""
from datetime import datetime, timedelta

import pytest

from .it_harness import create_auto, wait_for

pytestmark = pytest.mark.integration


def test_time_trigger_fires_and_is_consumed(backend, client):
    """§4.3/§6: a `time` trigger fires once via the 15s tick loop, produces a
    'Once' execution, and vanishes from the trigger list. Slow by nature —
    the first tick baselines at ~15s, so `at` sits just past it."""
    a = create_auto(client, name="Punctual")
    at = (datetime.now() + timedelta(seconds=20)).isoformat(timespec="seconds")
    r = client.patch(f"/automations/{a['id']}", json={
        "triggers": [{"kind": "time", "at": at}]})
    assert r.status_code == 200, r.text

    def fired():
        rows = client.get("/executions").json()
        return next((e for e in rows
                     if e["autoId"] == a["id"] and e["trigger"] == "Once"), None)

    e = wait_for(fired, 75, "the one-shot to fire")
    assert e["status"] in ("executing", "succeeded")
    auto = client.get(f"/automations/{a['id']}").json()
    assert auto["triggers"] == []  # §4.3: consumed, never lingers spent
    assert auto["nextAt"] is None
