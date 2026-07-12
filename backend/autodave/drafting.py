"""Agent drafting pipeline (§8): two calls — write the spec, then build the steps.

Call 1 (create/edit): framework instructions + build instructions + the user's
request → spec.md. Call 2 (all modes; sync starts here): framework instructions +
build instructions + the spec → manifest.yaml (params, schedule) + step files.
Each call is followed by deterministic validation with one automatic repair round.
"""
from __future__ import annotations

import ast
import re
import threading
import uuid
from pathlib import Path

import yaml

from . import harness
from .events import hub
from .imports_check import disallowed_imports
from .specmd import blocks_to_md, md_to_blocks
from .storage import SECRET_REF_RE

PARAM_KINDS = {"toggle", "list", "kv", "number", "text"}
STEP_FILE_RE = re.compile(r"^(\d{2})-[a-z0-9][a-z0-9-]*\.py$")
FILE_MARK_RE = re.compile(r"^===FILE: (.+?)===\s*$", re.M)

# §8 prompt texts live as markdown next to the code so they can be read and
# edited without touching Python: framework-instructions.md opens EVERY drafting
# call (role, envelope, SDK, §6 policies); default-build-instructions.md seeds
# `instr` for new automations (users edit or delete freely — it versions like
# any instructions). The per-call TASK directives below stay in Python because
# they define the exact envelope the validators parse.
_INSTRUCTIONS_DIR = Path(__file__).parent / "instructions"
CONTRACT_PREAMBLE = (_INSTRUCTIONS_DIR / "framework-instructions.md").read_text(encoding="utf-8")
DEFAULT_INSTRUCTIONS = (_INSTRUCTIONS_DIR / "default-build-instructions.md").read_text(encoding="utf-8")

# ---------- prompts ----------

SPEC_TASK = {
    "create": (
        "TASK: write the spec. Draft spec.md for a brand-new automation from the USER REQUEST "
        "below, following the BUILD INSTRUCTIONS. Return exactly one file block, spec.md: "
        "markdown (# title first, then ## sections, - bullets, paragraphs) written for the user "
        "in plain words. Describe what the automation does, what it watches or produces, the "
        "schedule in words, and anything the user should be able to tune — no code, no yaml, "
        "no file names."
    ),
    "edit": (
        "TASK: rewrite the spec. Apply the USER REQUEST to the CURRENT spec.md below, following "
        "the BUILD INSTRUCTIONS. Return exactly one file block: the full updated spec.md. Keep "
        "everything the request doesn't touch unchanged."
    ),
}

STEPS_TASK = """TASK: build the automation that implements the SPEC below, following the BUILD INSTRUCTIONS. Derive the schedule, every parameter (each with a default), and the steps from the SPEC. Return manifest.yaml plus one file block per step — no spec.md:

===FILE: manifest.yaml===
name: Suggested automation name        # create mode only
desc: One-line description
note: One-line version note for the history menu
params:                                # each param MUST carry a default
  - { name: snake_case_name, kind: toggle|list|kv|number|text, label: ..., help: ..., default: ... }
schedule: { hour: 8, min: 0 }          # add dow: 0-6 (Sun=0) for weekly; omit -> daily 8:00
steps:                                 # ordered; file names NN-name.py, two-digit, gapless from 01
  - { file: 01-fetch.py, name: ..., desc: ... }
  - { file: 02-judge.py, name: ..., desc: ..., agent: true, why: one line — why judgment is needed }
===FILE: 01-fetch.py===
(python source)
===END===

Return every file named in steps."""


def spec_as_md(current: dict | None) -> str:
    """The spec may arrive as §5 blocks (stored versions) or as a raw markdown
    string (the §19 `spec` body field / in-editor draft) — yield markdown either way."""
    spec_val = (current or {}).get("spec") or []
    return spec_val if isinstance(spec_val, str) else blocks_to_md(spec_val)


def _common_context(current: dict | None, grants: dict) -> list[str]:
    """Grants + build instructions — sent with BOTH calls, in every mode."""
    parts = [
        "Grants for this automation — enabled agents (agent: true steps allowed only if nonempty): "
        f"{', '.join(grants.get('agents', [])) or 'none'}; allowed secret names: "
        f"{', '.join(grants.get('secrets', [])) or 'none'}."
    ]
    # §8: instructions travel with every call as context only — never returned by
    # the agent. In create mode the API seeds DEFAULT_INSTRUCTIONS when none given.
    if (current or {}).get("instr"):
        parts.append("=== BUILD INSTRUCTIONS (the user's standing rules — follow them; "
                     "never return this file) ===\n" + current["instr"].strip())
    return parts


def build_spec_prompt(mode: str, user_text: str | None, current: dict | None,
                      grants: dict) -> str:
    """§8 call 1 — framework + build instructions + user request → spec.md."""
    parts = [CONTRACT_PREAMBLE, SPEC_TASK[mode], *_common_context(current, grants)]
    if mode == "edit" and current:
        parts.append("=== CURRENT spec.md ===\n" + spec_as_md(current))
        # today's steps travel as context so the rewrite knows what already exists
        for s in current.get("steps", []):
            parts.append(f"=== CURRENT step {s.get('file')} ({s.get('name')}) ===\n{s.get('code', '')}")
    if user_text:
        parts.append("=== USER REQUEST ===\n" + user_text.strip())
    return "\n\n".join(parts)


def build_steps_prompt(mode: str, spec_md: str, current: dict | None,
                       grants: dict) -> str:
    """§8 call 2 — framework + build instructions + spec → manifest + step files."""
    parts = [CONTRACT_PREAMBLE, STEPS_TASK, *_common_context(current, grants)]
    if mode == "create":
        parts.append("MODE: create — include a suggested `name` in manifest.yaml.")
    else:
        parts.append(f"MODE: {mode} — the CURRENT files below are today's implementation; "
                     "rewrite them to match the SPEC, changing no more than the spec demands.")
        if current:
            parts.append("=== CURRENT param definitions ===\n"
                         + yaml.safe_dump(current.get("params", []), sort_keys=False))
            for s in current.get("steps", []):
                parts.append(f"=== CURRENT step {s.get('file')} ({s.get('name')}) ===\n{s.get('code', '')}")
    parts.append("=== SPEC (spec.md — implement this exactly) ===\n" + (spec_md or "").strip())
    return "\n\n".join(parts)


# ---------- envelope + validation ----------

def parse_envelope(text: str) -> dict[str, str]:
    """Blocks by filename. Prose before the first marker is ignored; no ===END=== → invalid."""
    if "===END===" not in text:
        raise ValueError("response is truncated — no ===END=== marker")
    body = text[: text.index("===END===")]
    marks = list(FILE_MARK_RE.finditer(body))
    if not marks:
        raise ValueError("no ===FILE: blocks in the response")
    files: dict[str, str] = {}
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(body)
        files[m.group(1).strip()] = body[m.end():end].strip("\n") + "\n"
    return files


def validate_spec(files: dict[str, str]) -> tuple[dict, list[str]]:
    """§8 call-1 validation. Returns ({md, blocks}, errors)."""
    errors: list[str] = []
    if "spec.md" not in files:
        errors.append("spec.md is missing")
    extras = sorted(f for f in files if f != "spec.md")
    if extras:
        errors.append(f"the spec call must return spec.md and nothing else (got {extras})")
    if errors:
        return {}, errors
    md = files["spec.md"]
    blocks = md_to_blocks(md)
    if not blocks or blocks[0].get("k") != "h1" or not blocks[0].get("text", "").strip():
        errors.append("spec.md must start with a # title")
    if not any(b.get("k") in ("p", "li") for b in blocks):
        errors.append("spec.md has no body — describe the automation")
    if errors:
        return {}, errors
    return {"md": md, "blocks": blocks}, []


def validate_steps(files: dict[str, str]) -> tuple[dict, list[str]]:
    """§8 call-2 validation. Returns (draft dict sans spec, errors)."""
    errors: list[str] = []
    if "manifest.yaml" not in files:
        errors.append("manifest.yaml is missing")
    if "spec.md" in files:
        errors.append("the steps call must not return spec.md — the spec is already settled")
    if errors:
        return {}, errors
    try:
        manifest = yaml.safe_load(files["manifest.yaml"]) or {}
    except yaml.YAMLError as e:
        return {}, [f"manifest.yaml doesn't parse: {e}"]
    if not isinstance(manifest, dict):
        return {}, ["manifest.yaml must be a mapping"]

    params = manifest.get("params") or []
    for p in params:
        if not isinstance(p, dict) or "name" not in p or "kind" not in p:
            errors.append(f"param entry malformed: {p!r}")
            continue
        if p["kind"] not in PARAM_KINDS:
            errors.append(f"param {p['name']}: unknown kind {p['kind']}")
        if "default" not in p:
            errors.append(f"param {p['name']}: missing default")
        if p["kind"] == "number" and "min" not in p:
            p["min"] = 0

    steps = manifest.get("steps") or []
    if not steps:
        errors.append("steps must be nonempty")
    listed = [s.get("file", "") for s in steps if isinstance(s, dict)]
    blocks = [f for f in files if f != "manifest.yaml"]
    if sorted(listed) != sorted(blocks):
        errors.append(f"steps[].file and file blocks don't match 1:1 (manifest: {listed}, blocks: {blocks})")
    for i, fname in enumerate(listed, 1):
        m = STEP_FILE_RE.match(fname or "")
        if not m:
            errors.append(f"step file {fname!r} doesn't follow NN-name.py")
        elif int(m.group(1)) != i:
            errors.append(f"step file {fname!r} out of order — expected {i:02d}-…")
    for s in steps:
        if isinstance(s, dict) and s.get("agent") and not (s.get("why") or "").strip():
            errors.append(f"step {s.get('name')}: agent: true requires a why")

    norm_steps = []
    for s in steps:
        if not isinstance(s, dict):
            continue
        code = files.get(s.get("file", ""), "")
        try:
            ast.parse(code)
            for mod in disallowed_imports(code):
                errors.append(f"{s.get('file')}: import {mod} isn't allowed")
        except SyntaxError as e:
            errors.append(f"{s.get('file')}: syntax error — {e.msg} (line {e.lineno})")
        norm_steps.append({
            "file": s.get("file"), "name": s.get("name", ""), "desc": s.get("desc", ""),
            "agent": bool(s.get("agent")), "why": s.get("why", ""), "code": code,
        })
    sched = manifest.get("schedule") or {}
    if sched:
        if not isinstance(sched, dict) or not (0 <= int(sched.get("hour", 8)) <= 23) \
                or not (0 <= int(sched.get("min", 0)) <= 59) \
                or (sched.get("dow") is not None and not (0 <= int(sched["dow"]) <= 6)):
            errors.append("schedule out of range (hour 0-23, min 0-59, dow 0-6)")
    if errors:
        return {}, errors
    draft = {
        "schedule": {"hour": int(sched.get("hour", 8)), "min": int(sched.get("min", 0)),
                     "dow": int(sched["dow"]) if sched.get("dow") is not None else None},
        "name": manifest.get("name"),
        "desc": manifest.get("desc", ""),
        "note": manifest.get("note", ""),
        "params": params,
        "steps": norm_steps,
        "secretRefs": sorted({m for st in norm_steps for m in SECRET_REF_RE.findall(st["code"])}),
    }
    return draft, []


# ---------- background jobs ----------

class DraftJobs:
    """§19 POST /drafts — the two-call pipeline as a background job, one
    automatic repair round per call (§8)."""

    def __init__(self) -> None:
        self.jobs: dict[str, dict] = {}
        self._lock = threading.Lock()

    def start(self, mode: str, agent: dict, user_text: str | None,
              current: dict | None, grants: dict) -> str:
        job_id = str(uuid.uuid4())
        stage = "Writing the spec" if mode in ("create", "edit") else "Generating the steps"
        job = {"id": job_id, "status": "building", "stage": stage,
               "error": None, "draft": None, "mode": mode, "_cancel": False, "_proc": {}}
        with self._lock:
            self.jobs[job_id] = job
        t = threading.Thread(target=self._run, args=(job, mode, agent, user_text, current, grants),
                             daemon=True)
        t.start()
        return job_id

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            j = self.jobs.get(job_id)
        if not j:
            return None
        return {k: v for k, v in j.items() if not k.startswith("_")}

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            j = self.jobs.get(job_id)
        if not j:
            return False
        j["_cancel"] = True
        proc = j["_proc"].get("proc")
        if proc and proc.poll() is None:
            proc.terminate()
        j["status"] = "cancelled"
        hub.publish("draft.progress", jobId=job_id, status="cancelled", stage=None)
        return True

    def _run(self, job: dict, mode: str, agent: dict, user_text: str | None,
             current: dict | None, grants: dict) -> None:
        try:
            cancelled = self._pipeline(job, mode, agent, user_text, current, grants)
            if cancelled:
                return
        except harness.HarnessError as e:
            if job["_cancel"]:
                return
            job["status"] = "failed"
            job["error"] = str(e)
        hub.publish("draft.progress", jobId=job["id"], status=job["status"],
                    stage=None, error=job.get("error"))

    def _pipeline(self, job: dict, mode: str, agent: dict, user_text: str | None,
                  current: dict | None, grants: dict) -> bool:
        """Runs both calls; sets job status. Returns True when cancelled mid-flight."""
        spec_blocks = None
        if mode in ("create", "edit"):
            # ---- call 1: the spec ----
            spec, errors = self._call_with_repair(
                job, agent, build_spec_prompt(mode, user_text, current, grants), validate_spec)
            if job["_cancel"]:
                return True
            if errors:
                return self._fail(job, "The spec didn't validate — try again or rephrase.", errors)
            spec_md, spec_blocks = spec["md"], spec["blocks"]
        else:
            # sync: the provided spec IS the input — no spec call
            spec_md = spec_as_md(current)

        # ---- call 2: steps, params, schedule ----
        self._stage(job, "Generating the steps")
        draft, errors = self._call_with_repair(
            job, agent, build_steps_prompt(mode, spec_md, current, grants), validate_steps)
        if job["_cancel"]:
            return True
        if errors:
            return self._fail(job, "The steps didn't validate — try again or rephrase.", errors)

        draft["spec"] = spec_blocks  # None on sync — the spec never changes there
        if mode == "create":
            # Hand the (seeded or user-given) instructions back so the
            # Review card arrives pre-filled — agents never return them.
            draft["instr"] = (current or {}).get("instr") or ""
        job["status"] = "done"
        job["draft"] = draft
        return False

    def _call_with_repair(self, job: dict, agent: dict, prompt: str,
                          validator) -> tuple[dict, list[str]]:
        """One harness call + one automatic repair round against `validator`."""
        self._log_app(f"draft {job['id']} prompt:\n{prompt}")
        raw = harness.invoke(agent, prompt, timeout=300, proc_holder=job["_proc"])
        self._log_app(f"draft {job['id']} response:\n{raw}")
        if job["_cancel"]:
            return {}, []
        result, errors = self._parse_validate(raw, validator)
        if errors:
            repair = (prompt + "\n\n=== YOUR PREVIOUS RESPONSE ===\n" + raw
                      + "\n\n=== VALIDATION ERRORS — fix these and resend the full envelope ===\n- "
                      + "\n- ".join(errors))
            raw2 = harness.invoke(agent, repair, timeout=300, proc_holder=job["_proc"])
            self._log_app(f"draft {job['id']} repair response:\n{raw2}")
            if job["_cancel"]:
                return {}, []
            result, errors = self._parse_validate(raw2, validator)
        return result, errors

    def _stage(self, job: dict, label: str) -> None:
        job["stage"] = label
        hub.publish("draft.progress", jobId=job["id"], status="building", stage=label)

    @staticmethod
    def _fail(job: dict, msg: str, errors: list[str]) -> bool:
        job["status"] = "failed"
        job["error"] = msg
        job["errorDetail"] = errors[:8]
        return False

    @staticmethod
    def _parse_validate(raw: str, validator) -> tuple[dict, list[str]]:
        try:
            files = parse_envelope(raw)
        except ValueError as e:
            return {}, [str(e)]
        return validator(files)

    @staticmethod
    def _log_app(text: str) -> None:
        from . import paths

        try:
            with open(paths.app_log(), "a", encoding="utf-8") as f:
                f.write(text[:100_000] + "\n\n")
        except OSError:
            pass


draft_jobs = DraftJobs()
