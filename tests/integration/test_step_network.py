"""§15 integration: network-shaped behavior against localhost-only doubles —
`fetch_page` vs a local web server, `packages.ensure` vs a local wheel dir."""
import pytest

from .it_harness import build_wheel, create_auto, wait_status

pytestmark = pytest.mark.integration


def test_fetch_page_respects_local_robots(backend, client, web_server):
    base, docroot = web_server
    (docroot / "robots.txt").write_text("User-agent: *\nDisallow: /private/\n")
    (docroot / "page.html").write_text("<p>hello-from-web</p>")
    (docroot / "private").mkdir()
    (docroot / "private" / "x.html").write_text("secret")

    a = create_auto(client, name="Fetcher", steps=[
        {"file": "01-fetch.py", "name": "Fetch", "desc": "allowed",
         "code": f'log(fetch_page("{base}/page.html").strip())\n'},
    ])
    exec_id = client.post(f"/automations/{a['id']}/execute", json={}).json()["execId"]
    e = wait_status(client, exec_id)
    assert e["status"] == "succeeded"
    lines = client.get(f"/executions/{exec_id}/logs",
                       params={"step": 0, "attempt": 1}).json()["lines"]
    assert any("hello-from-web" in ln["text"] for ln in lines)

    blocked = create_auto(client, name="Blocked fetcher", steps=[
        {"file": "01-fetch.py", "name": "Fetch", "desc": "disallowed",
         "code": f'fetch_page("{base}/private/x.html")\n'},
    ])
    exec_id = client.post(f"/automations/{blocked['id']}/execute", json={}).json()["execId"]
    e = wait_status(client, exec_id)
    assert e["status"] == "failed"
    assert "robots.txt disallows" in e["error"]["message"]


def test_declared_package_installs_from_local_wheel(backend_factory, tmp_path):
    """§6.2: a real `pip install --target` into the home's site-packages/, fed
    from a local wheel dir instead of PyPI (PIP_NO_INDEX + PIP_FIND_LINKS)."""
    wheels = tmp_path / "wheels"
    build_wheel(wheels)
    b = backend_factory(extra_env={"PIP_NO_INDEX": "1", "PIP_FIND_LINKS": str(wheels)})
    with b.client() as client:
        a = create_auto(client, name="Wheeled",
                        packages=[{"pip": "tinypkg", "import": "tinypkg"}],
                        steps=[{"file": "01-use.py", "name": "Use", "desc": "imports",
                                "code": 'import tinypkg\nlog(tinypkg.MARKER)\n'}])
        exec_id = client.post(f"/automations/{a['id']}/execute", json={}).json()["execId"]
        e = wait_status(client, exec_id, timeout=120)
        assert e["status"] == "succeeded", e.get("error")
        assert (b.home / "site-packages" / "tinypkg" / "__init__.py").exists()
        lines = client.get(f"/executions/{exec_id}/logs",
                           params={"step": 0, "attempt": 1}).json()["lines"]
        assert any("tinypkg-1.0.0" in ln["text"] for ln in lines)
