"""`autowright` CLI (§2/§3): Client bootstrap errors, automation lookup, log follow.

No real server anywhere — the Client's request layer is faked/stubbed.
"""
import json

import pytest


# ---------------------------------------------------------------- Client boot

def test_client_exits_cleanly_when_backend_json_missing(home):
    from autowright import cli

    with pytest.raises(SystemExit) as ei:
        cli.Client()
    # sys.exit(str) → message is the exit code, printed to stderr — no traceback
    assert "backend isn't up" in str(ei.value.code)
    assert "no backend.json" in str(ei.value.code)


def test_client_exits_cleanly_on_stale_backend_json(home):
    # Staleness is detected by parse: a SIGKILL'd backend leaves a truncated
    # or garbage backend.json. (A well-formed file with a dead port passes the
    # constructor — that failure surfaces at request time, not here.)
    from autowright import cli, paths

    bj = paths.backend_json()
    bj.write_text('{"port": 51')  # truncated mid-write
    with pytest.raises(SystemExit) as ei:
        cli.Client()
    assert "stale or unreadable" in str(ei.value.code)

    bj.write_text(json.dumps({"pid": 999}))  # valid JSON, keys gone
    with pytest.raises(SystemExit) as ei:
        cli.Client()
    assert "stale or unreadable" in str(ei.value.code)


def test_client_reads_port_and_token_from_backend_json(home):
    from autowright import cli, paths

    paths.backend_json().write_text(json.dumps({"port": 5151, "token": "tok"}))
    c = cli.Client()
    assert c.base == "http://127.0.0.1:5151"
    assert c.token == "tok"


# ---------------------------------------------------------------- find_auto

class _ListClient:
    """Stub standing in for Client — find_auto only calls req GET /automations."""

    def __init__(self, autos):
        self.autos = autos

    def req(self, method, path, body=None):
        assert (method, path) == ("GET", "/automations")
        return self.autos


AUTOS = [
    {"id": "abc12345", "name": "Daily Report"},
    {"id": "def67890", "name": "Weekly Report"},
    {"id": "ghi00000", "name": "Backup"},
]


def test_find_auto_exact_id():
    from autowright.cli import find_auto

    assert find_auto(_ListClient(AUTOS), "abc12345")["name"] == "Daily Report"


def test_find_auto_exact_name_case_insensitive():
    from autowright.cli import find_auto

    assert find_auto(_ListClient(AUTOS), "dAiLy RePoRt")["id"] == "abc12345"


def test_find_auto_unique_substring():
    from autowright.cli import find_auto

    assert find_auto(_ListClient(AUTOS), "back")["id"] == "ghi00000"
    assert find_auto(_ListClient(AUTOS), "week")["id"] == "def67890"


def test_find_auto_ambiguous_substring_exits():
    from autowright.cli import find_auto

    with pytest.raises(SystemExit) as ei:
        find_auto(_ListClient(AUTOS), "report")  # Daily + Weekly both match
    msg = str(ei.value.code)
    assert "no unique automation" in msg
    assert "Daily Report" in msg and "Weekly Report" in msg


def test_find_auto_no_match_exits():
    from autowright.cli import find_auto

    with pytest.raises(SystemExit) as ei:
        find_auto(_ListClient([]), "zzz")
    assert "(none)" in str(ei.value.code)


# ---------------------------------------------------------------- follow_exec

class _FollowClient:
    """Scripted two-poll client: overlapping exec-log seqs across polls, and
    one step attempt that is terminal from the first poll onward."""

    def __init__(self):
        self.poll = 0
        self.step_log_fetches = 0

    @staticmethod
    def _ln(seq, text):
        return {"seq": seq, "t": f"T{seq}", "k": "log", "text": text}

    def req(self, method, path, body=None):
        assert method == "GET"
        if path == "/executions/e1":
            self.poll += 1
            return {
                "status": "executing" if self.poll == 1 else "succeeded",
                "dur": "2s",
                "steps": [{"attempts": [{"n": 1, "status": "ok"}]}],  # terminal
            }
        if path == "/executions/e1/logs":
            if self.poll == 1:
                return {"lines": [self._ln(1, "alpha"), self._ln(2, "beta")]}
            # poll 2 re-serves seqs 1-2 plus the new 3 — dedupe must hold
            return {"lines": [self._ln(1, "alpha"), self._ln(2, "beta"),
                              self._ln(3, "gamma")]}
        if path == "/executions/e1/logs?step=0&attempt=1":
            self.step_log_fetches += 1
            return {"lines": [self._ln(1, "step line")]}
        raise AssertionError(f"unexpected request: {path}")


def test_follow_exec_dedupes_seqs_and_settles_terminal_attempts(monkeypatch, capsys):
    from autowright import cli

    monkeypatch.setattr(cli.time, "sleep", lambda s: None)
    c = _FollowClient()
    cli.follow_exec(c, "e1")
    out = capsys.readouterr().out.splitlines()
    assert out == [
        "  T1 [log] alpha",
        "  T2 [log] beta",
        "  T1 [log] step line",
        "  T3 [log] gamma",          # only the new seq on poll 2
        "→ succeeded in 2s",
    ]
    assert out.count("  T1 [log] alpha") == 1  # overlapping seqs printed once
    # terminal attempt settled after its first fetch — never re-downloaded
    assert c.step_log_fetches == 1
