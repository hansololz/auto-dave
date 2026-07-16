import pytest

from autodave.drafting import (build_spec_prompt, build_steps_prompt, parse_blockers,
                               parse_envelope, spec_as_md, validate_spec, validate_steps)

GOOD_SPEC = """prose the parser must ignore
===FILE: spec.md===
# Hello

Does things.
===END===
"""

GOOD_STEPS = """some prose the parser must ignore
===FILE: manifest.yaml===
name: Hello
desc: Says hello
note: Created
params:
  - { name: on_off, kind: toggle, label: On, help: h, default: true }
steps:
  - { file: 01-a.py, name: A, desc: d }
  - { file: 02-b.py, name: B, desc: d, agent: true, why: needs judgment }
===FILE: 01-a.py===
log("a")
===FILE: 02-b.py===
answer = agent.ask("what?")
===END===
trailing prose ignored too
"""

GRANTS = {"agents": [], "secrets": []}


# ---------- call 1: the spec ----------

def test_parse_and_validate_spec_good():
    files = parse_envelope(GOOD_SPEC)
    assert set(files) == {"spec.md"}
    spec, errors = validate_spec(files)
    assert errors == []
    assert spec["blocks"][0] == {"k": "h1", "text": "Hello"}
    assert "Does things." in spec["md"]


def test_spec_call_must_return_only_spec():
    files = parse_envelope(GOOD_SPEC)
    files["manifest.yaml"] = "name: x\n"
    _, errors = validate_spec(files)
    assert any("nothing else" in e for e in errors)


def test_spec_must_start_with_title():
    _, errors = validate_spec({"spec.md": "Does things without a title.\n"})
    assert any("# title" in e for e in errors)


def test_spec_needs_a_body():
    _, errors = validate_spec({"spec.md": "# Title only\n"})
    assert any("no body" in e for e in errors)


def test_truncated_envelope_rejected():
    with pytest.raises(ValueError, match="truncated"):
        parse_envelope(GOOD_STEPS.replace("===END===", ""))


# ---------- call 2: steps, params, schedule ----------

def test_parse_and_validate_steps_good():
    files = parse_envelope(GOOD_STEPS)
    assert set(files) == {"manifest.yaml", "01-a.py", "02-b.py"}
    draft, errors = validate_steps(files)
    assert errors == []
    assert draft["name"] == "Hello"
    assert draft["steps"][1]["agent"] is True
    assert "spec" not in draft  # the spec is settled in call 1


def test_no_schedule_key_means_no_schedule():
    # GOOD_STEPS carries no `schedule:` — the automation is manual / menu bar only.
    draft, errors = validate_steps(parse_envelope(GOOD_STEPS))
    assert errors == []
    assert draft["schedule"] is None


def test_schedule_key_is_parsed():
    withsched = GOOD_STEPS.replace(
        "note: Created\n", "note: Created\nschedule: { hour: 7, min: 30, dow: 2 }\n")
    draft, errors = validate_steps(parse_envelope(withsched))
    assert errors == []
    assert draft["schedule"] == {"hour": 7, "min": 30, "dow": 2}


def test_steps_call_must_not_return_spec():
    files = parse_envelope(GOOD_STEPS)
    files["spec.md"] = "# Sneaky\n"
    _, errors = validate_steps(files)
    assert any("must not return spec.md" in e for e in errors)


def test_missing_default_rejected():
    bad = GOOD_STEPS.replace(", default: true", "")
    _, errors = validate_steps(parse_envelope(bad))
    assert any("missing default" in e for e in errors)


def test_bad_import_rejected():
    bad = GOOD_STEPS.replace('log("a")', "import numpy")
    _, errors = validate_steps(parse_envelope(bad))
    assert any("numpy" in e for e in errors)


def test_curated_imports_allowed():
    ok = GOOD_STEPS.replace('log("a")', "import requests\nimport json\nfrom bs4 import BeautifulSoup")
    _, errors = validate_steps(parse_envelope(ok))
    assert errors == []


def test_syntax_error_rejected():
    bad = GOOD_STEPS.replace('log("a")', "def broken(:")
    _, errors = validate_steps(parse_envelope(bad))
    assert any("syntax error" in e for e in errors)


def test_gapless_step_numbering_enforced():
    bad = GOOD_STEPS.replace("02-b.py", "03-b.py")
    _, errors = validate_steps(parse_envelope(bad))
    assert any("out of order" in e for e in errors)


def test_agent_step_requires_why():
    bad = GOOD_STEPS.replace(", why: needs judgment", "")
    _, errors = validate_steps(parse_envelope(bad))
    assert any("requires a why" in e for e in errors)


def test_step_file_block_mismatch():
    files = parse_envelope(GOOD_STEPS)
    del files["02-b.py"]
    _, errors = validate_steps(files)
    assert any("1:1" in e for e in errors)


# ---------- §8 blocker envelope ----------

BLOCKED = """prose the parser must ignore
===BLOCKED===
blockers:
  - reason: Needs physical mail.
    fix: Use a digital source.
    details: Only files and web pages are reachable.
===END===
"""


def test_parse_blockers_good():
    assert parse_blockers(BLOCKED) == [{"reason": "Needs physical mail.",
                                        "fix": "Use a digital source.",
                                        "details": "Only files and web pages are reachable."}]


def test_parse_blockers_details_optional():
    bl = parse_blockers(BLOCKED.replace("    details: Only files and web pages are reachable.\n", ""))
    assert bl[0]["details"] == ""


def test_parse_blockers_none_for_file_envelopes():
    # a normal file-block response isn't a blocker — validation proceeds as usual
    assert parse_blockers(GOOD_SPEC) is None
    assert parse_blockers(GOOD_STEPS) is None


def test_blocker_requires_reason_and_fix():
    with pytest.raises(ValueError, match="reason and fix"):
        parse_blockers(BLOCKED.replace("    fix: Use a digital source.\n", ""))


def test_blocker_list_must_be_nonempty():
    with pytest.raises(ValueError, match="nonempty"):
        parse_blockers("===BLOCKED===\nblockers: []\n===END===\n")


def test_blocker_must_not_mix_file_blocks():
    mixed = BLOCKED.replace("===BLOCKED===", "===FILE: spec.md===\n# Sneaky\n===BLOCKED===")
    with pytest.raises(ValueError, match="must not carry file blocks"):
        parse_blockers(mixed)


def test_truncated_blocker_rejected():
    with pytest.raises(ValueError, match="truncated"):
        parse_blockers(BLOCKED.replace("===END===", ""))


# ---------- prompts ----------

def test_spec_prompt_carries_framework_instructions_and_request():
    p = build_spec_prompt("create", "Watch a product price", None, GRANTS)
    assert "automation writer inside Auto Dave" in p   # framework-instructions.md
    assert "TASK: update the SPEC" in p
    assert "=== USER REQUEST ===\nWatch a product price" in p


def test_prompts_carry_blocker_contract():
    # §8: framework-instructions travel with every call, blocker envelope included
    for p in (build_spec_prompt("create", "x", None, GRANTS),
              build_steps_prompt("sync", "# T\n\nBody.", None, GRANTS)):
        assert "===BLOCKED===" in p


def test_spec_prompt_section_order():
    # §8 call 1: agents, secrets, build instructions, framework, original spec,
    # user request, then the TASK ask — in that order.
    cur = {"instr": "Never touch the Documents folder.",
           "spec": [{"k": "h1", "text": "Title"}, {"k": "p", "text": "Block spec body."}],
           "params": [], "steps": []}
    p = build_spec_prompt("edit", "also check weekends", cur, GRANTS)
    order = [p.index("Available agents"), p.index("Available secrets"),
             p.index("BUILD INSTRUCTIONS"), p.index("automation writer inside Auto Dave"),
             p.index("=== ORIGINAL SPEC"), p.index("=== USER REQUEST"),
             p.index("TASK: update the SPEC")]
    assert order == sorted(order)


def test_spec_prompt_edit_embeds_current_spec_but_no_step_code():
    cur = {"spec": [{"k": "h1", "text": "Title"}, {"k": "p", "text": "Block spec body."}],
           "params": [], "steps": [{"file": "01-a.py", "name": "A", "code": 'log("old")'}]}
    p = build_spec_prompt("edit", "also check weekends", cur, GRANTS)
    assert "TASK: update the SPEC" in p
    assert "Block spec body." in p
    assert 'log("old")' not in p


def test_steps_prompt_embeds_spec_and_framework():
    p = build_steps_prompt("create", "# Raw\n\nString spec body.", None, GRANTS)
    assert "automation writer inside Auto Dave" in p
    assert "TASK: build the automation" in p
    assert "String spec body." in p


def test_steps_prompt_sync_embeds_current_files():
    cur = {"params": [{"name": "n", "kind": "number", "default": 1}],
           "steps": [{"file": "01-a.py", "name": "A", "code": 'log("old")'}]}
    p = build_steps_prompt("sync", "# T\n\nBody.", cur, GRANTS)
    assert "MODE: sync" in p
    assert 'log("old")' in p


def test_spec_as_md_accepts_blocks_and_strings():
    # UI "ask the agent" flow serializes the in-editor draft as §5 blocks; the
    # §19 `spec` body field arrives as a raw markdown string. Both must work.
    blocks = {"spec": [{"k": "h1", "text": "Title"}, {"k": "h2", "text": "Change (draft)"},
                       {"k": "p", "text": "Block spec body."}]}
    assert "## Change (draft)" in spec_as_md(blocks)
    assert spec_as_md({"spec": "# Raw\n\nString spec body."}) == "# Raw\n\nString spec body."


def test_prompts_carry_build_instructions_in_every_mode():
    # §8: build instructions travel with BOTH calls, in every mode.
    cur = {"instr": "Never touch the Documents folder.", "spec": "# T", "params": [], "steps": []}
    for mode in ("create", "edit"):
        p = build_spec_prompt(mode, "do the thing", cur, GRANTS)
        assert "BUILD INSTRUCTIONS" in p and "Never touch the Documents folder." in p
    for mode in ("create", "edit", "sync"):
        p = build_steps_prompt(mode, "# T\n\nBody.", cur, GRANTS)
        assert "BUILD INSTRUCTIONS" in p and "Never touch the Documents folder." in p


def test_no_instructions_section_when_absent():
    p = build_spec_prompt("create", "do the thing", None, GRANTS)
    assert "BUILD INSTRUCTIONS (the user's standing rules" not in p


# ---------- fake claude CLI (tests/bin) drives the full pipeline ----------

def test_fake_cli_two_phase_validates():
    from autodave import harness

    spec_raw = harness.invoke({"harness": "Claude Code"},
                              build_spec_prompt("create", "Track my packages", None, GRANTS))
    spec, errors = validate_spec(parse_envelope(spec_raw))
    assert errors == []
    steps_raw = harness.invoke({"harness": "Claude Code"},
                               build_steps_prompt("create", spec["md"], None, GRANTS))
    draft, errors = validate_steps(parse_envelope(steps_raw))
    assert errors == []
    assert draft["steps"] and draft["name"] == "Track my packages"


def test_create_job_payload_carries_spec_mid_job(monkeypatch):
    # §11 drafting-on-Review / §19: on create, call 1's validated spec rides
    # the job payload before the steps call runs, so the spec card can render
    # it while the steps are still generating.
    import time

    from autodave import harness
    from autodave.drafting import DraftJobs

    jobs = DraftJobs()
    seen = {}

    def fake_invoke(agent, prompt, timeout=300, proc_holder=None):
        if "TASK: update the SPEC" in prompt:
            return GOOD_SPEC
        seen["mid"] = next(iter(jobs.jobs.values())).get("draft")
        return GOOD_STEPS

    monkeypatch.setattr(harness, "invoke", fake_invoke)
    job_id = jobs.start("create", {"harness": "Claude Code"}, "Say hello", None, GRANTS)
    for _ in range(100):
        j = jobs.get(job_id)
        if j["status"] in ("done", "failed", "blocked"):
            break
        time.sleep(0.05)
    assert j["status"] == "done", j
    assert seen["mid"] and seen["mid"]["spec"][0] == {"k": "h1", "text": "Hello"}
