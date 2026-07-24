"""§15 integration: the real CLI as a subprocess against a live backend."""
import pytest

from .it_harness import create_auto, run_cli, wait_status

pytestmark = pytest.mark.integration


def test_cli_list_and_agents(backend, client):
    create_auto(client, name="From HTTP")
    r = run_cli(backend.home, "list")
    assert r.returncode == 0, r.stderr
    assert "From HTTP" in r.stdout

    r = run_cli(backend.home, "agents")
    assert r.returncode == 0, r.stderr


def test_cli_execute_follow_streams_to_exit(backend, client):
    a = create_auto(client, name="Followed")
    r = run_cli(backend.home, "execute", "--follow", "Followed")
    assert r.returncode == 0, r.stderr + r.stdout
    assert "integration says hi" in r.stdout
    e = client.get("/executions").json()[0]
    assert e["autoId"] == a["id"]
    assert e["status"] == "succeeded"


def test_cli_export_import_roundtrip(backend, client, tmp_path):
    create_auto(client, name="Traveler")
    out = tmp_path / "traveler.autowright"
    r = run_cli(backend.home, "export", "Traveler", str(out))
    assert r.returncode == 0, r.stderr + r.stdout
    assert out.exists() and out.stat().st_size > 0

    r = run_cli(backend.home, "import", str(out))
    assert r.returncode == 0, r.stderr + r.stdout
    names = [x["name"] for x in client.get("/automations").json()]
    assert names.count("Traveler") == 2  # §5.1 import always creates a new automation


def test_cli_executions_lists_the_run(backend, client):
    a = create_auto(client, name="Historied")
    exec_id = client.post(f"/automations/{a['id']}/execute", json={}).json()["execId"]
    wait_status(client, exec_id)
    r = run_cli(backend.home, "executions")
    assert r.returncode == 0, r.stderr
    assert "Historied" in r.stdout
