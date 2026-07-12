import pytest

from autodave.drafting import (build_spec_prompt, build_steps_prompt, parse_envelope,
                               spec_as_md, validate_spec, validate_steps)

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


# ---------- prompts ----------

def test_spec_prompt_carries_framework_instructions_and_request():
    p = build_spec_prompt("create", "Watch a product price", None, GRANTS)
    assert "automation writer inside Auto Dave" in p   # framework-instructions.md
    assert "TASK: write the spec" in p
    assert "=== USER REQUEST ===\nWatch a product price" in p


def test_spec_prompt_edit_embeds_current_spec_and_steps():
    cur = {"spec": [{"k": "h1", "text": "Title"}, {"k": "p", "text": "Block spec body."}],
           "params": [], "steps": [{"file": "01-a.py", "name": "A", "code": 'log("old")'}]}
    p = build_spec_prompt("edit", "also check weekends", cur, GRANTS)
    assert "TASK: rewrite the spec" in p
    assert "Block spec body." in p
    assert 'log("old")' in p


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
