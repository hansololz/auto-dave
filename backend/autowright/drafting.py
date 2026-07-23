"""Agent drafting pipeline (§8): two calls — write the spec, then build the steps.

Call 1 (create/edit): framework instructions + available agents + available secrets +
build instructions + the original spec (edit only) + the user's request → spec.md;
step code never travels here. Call 2 (create/sync; sync starts here): framework
instructions + build instructions + the spec → manifest.yaml (params, triggers) + step files.
`edit` makes call 1 only — the rewritten spec lands out of sync and a later `sync`
job rebuilds the steps. `question` makes one read-only call whose raw response is
the answer (§11 Ask panel) — no envelope. Each call is followed by deterministic validation with
one automatic repair round; a valid ===BLOCKED=== envelope instead ends the job
in the terminal `blocked` state with the agent's blocker list (§8).
"""
from __future__ import annotations

import ast
import logging
import re
import threading
import time
import uuid
from pathlib import Path

import yaml

from . import harness, packages as pkglib, schedule
from .events import hub
from .imports_check import ALLOWED_IMPORTS, disallowed_imports
from .specmd import blocks_to_md, md_to_blocks
from .storage import SECRET_REF_RE

log = logging.getLogger("autowright.drafting")

PARAM_KINDS = {"toggle", "list", "kv", "number", "text"}
STEP_FILE_RE = re.compile(r"^(\d{2})-[a-z0-9][a-z0-9-]*\.py$")
FILE_MARK_RE = re.compile(r"^===FILE: (.+?)===\s*$", re.M)
BLOCKED_MARK_RE = re.compile(r"^===BLOCKED===\s*$", re.M)

# §8 prompt texts live as markdown next to the code so they can be read and
# edited without touching Python: framework-instructions.md travels with EVERY
# drafting call (role, envelope, SDK, §6 policies); default-build-instructions.md seeds
# `instr` for new automations (users edit or delete freely — it versions like
# any instructions). The per-call TASK directives below stay in Python because
# they define the exact envelope the validators parse.
_INSTRUCTIONS_DIR = Path(__file__).parent / "instructions"
CONTRACT_PREAMBLE = (_INSTRUCTIONS_DIR / "framework-instructions.md").read_text(encoding="utf-8")
DEFAULT_INSTRUCTIONS = (_INSTRUCTIONS_DIR / "default-build-instructions.md").read_text(encoding="utf-8")

# §8: every prompt section opens with a `=== NAME ===` header — one dialect
# throughout, visually distinct from the envelope's ===FILE:/===END=== markers.
_FRAMEWORK_SECTION = "=== FRAMEWORK INSTRUCTIONS ===\n" + CONTRACT_PREAMBLE

# ---------- prompts ----------

SPEC_TASK = """=== TASK ===
Update the SPEC based on the USER REQUEST above. Return exactly one file block, spec.md — the full updated spec: markdown (# title first, then ## sections, - bullets, paragraphs) written for the user in plain words — no code, no yaml, no file names. Keep everything the request doesn't touch unchanged; when no ORIGINAL SPEC is given, write it fresh from the request. Shape and tone, for example:

===FILE: spec.md===
# Track new manga chapters

## What it does
- Every morning at 8, check each manga page on my list for a new chapter.
- Only genuinely new chapters count — reprints and reissues don't.

## What I see
- A notification naming the new chapters, only on days something new appeared.
- The result lists each new chapter with its title and date.
===END==="""

STEPS_TASK = """=== TASK ===
Build the automation that implements the SPEC below, following the BUILD INSTRUCTIONS. Derive the triggers, every parameter (each with a default), and the steps from the SPEC. Return manifest.yaml plus one file block per step — no spec.md:

===FILE: manifest.yaml===
name: Suggested automation name        # create mode only
desc: One-line description
note: One-line version note for the history menu
params:                                # each param MUST carry a default
  - { name: snake_case_name, kind: toggle|list|kv|number|text, label: ..., help: ..., default: ... }
packages:                              # extra PyPI packages beyond the allowed list (see Allowed imports);
  - { pip: pandas, import: pandas }    # bare distribution name, NO version; omit the key when none are needed
triggers:                              # cron entries only (see Triggers above); omit the whole key if the spec names no time (no triggers -> manual / menu bar only)
  - cron: "0 8 * * *"
steps:                                 # ordered; file names NN-name.py, two-digit, gapless from 01
  - { file: 01-fetch.py, name: ..., desc: ... }
  - { file: 02-judge.py, name: ..., desc: ..., agent: true, why: one line — why judgment is needed }
===FILE: 01-fetch.py===
(python source)
===END===

Return every file named in steps."""

# §8 call-2 closing section: restates the response shape after the (possibly
# long) context so the format sits at the end of the prompt as well as in STEPS_TASK.
STEPS_REMINDER = ("=== RESPONSE REMINDER ===\n"
                  "Respond with manifest.yaml plus one file block per step "
                  "(no spec.md), ending with ===END=== exactly.")

QUESTION_TASK = """=== TASK ===
Answer the QUESTION above about this automation, in plain markdown prose written for the user — no file blocks, no envelope, no yaml. Ground the answer in the SPEC and the CURRENT steps shown above; when something isn't decided there, say so plainly."""


def spec_as_md(current: dict | None) -> str:
    """The spec may arrive as §5 blocks (stored versions) or as a raw markdown
    string (the §19 `spec` body field / in-editor draft) — yield markdown either way."""
    spec_val = (current or {}).get("spec") or []
    return spec_val if isinstance(spec_val, str) else blocks_to_md(spec_val)


def _grants_yaml(entries: list[dict]) -> str:
    """§8: grant lists render as yaml (agents: name/description/harness/model,
    secrets: name/description) so the drafting agent can weigh each entry when
    deciding which agents and secrets the automation should use."""
    if not entries:
        return "none"
    return yaml.safe_dump(entries, sort_keys=False, allow_unicode=True).strip()


def _common_context(current: dict | None, grants: dict) -> list[str]:
    """Grants + build instructions — the steps call's shared context (call 1
    builds its own sections in its own order)."""
    parts = [
        "=== GRANTS FOR THIS AUTOMATION ===\n"
        "Enabled agents (yaml: name, description, harness, model; agent: true steps "
        "allowed only if nonempty):\n"
        f"{_grants_yaml(grants.get('agents', []))}\n"
        "Allowed secrets (yaml: name, description; reference by secrets.NAME):\n"
        f"{_grants_yaml(grants.get('secrets', []))}\n"
        "Use these entries to decide which agents and secrets the automation should use."
    ]
    # §8: instructions travel with every call as context only — never returned by
    # the agent. In create mode the API seeds DEFAULT_INSTRUCTIONS when none given.
    if (current or {}).get("instr"):
        parts.append("=== BUILD INSTRUCTIONS (the user's standing rules — follow them; "
                     "never return this file) ===\n" + current["instr"].strip())
    return parts


def build_spec_prompt(mode: str, user_text: str | None, current: dict | None,
                      grants: dict) -> str:
    """§8 call 1 — framework instructions + available agents + available secrets + build
    instructions + original spec (edit only) + user request → spec.md. Role first, task
    last. Step code never travels here; the closing TASK just asks to update the spec
    from the request."""
    parts = [
        _FRAMEWORK_SECTION,
        "=== AVAILABLE AGENTS (yaml: name, description, harness, model — they can power "
        "judgment steps when the automation is later built; don't promise AI judgment in "
        "the spec unless this list is nonempty. Use these entries to decide which agents "
        "the automation should use) ===\n"
        f"{_grants_yaml(grants.get('agents', []))}",
        "=== AVAILABLE SECRETS (yaml: name, description — use these entries to decide "
        "which secrets the automation should use) ===\n"
        f"{_grants_yaml(grants.get('secrets', []))}",
    ]
    if (current or {}).get("instr"):
        parts.append("=== BUILD INSTRUCTIONS (the user's standing rules — follow them; "
                     "never return this file) ===\n" + current["instr"].strip())
    if mode == "edit" and current:
        parts.append("=== ORIGINAL SPEC (spec.md) ===\n" + spec_as_md(current))
    if user_text:
        parts.append("=== USER REQUEST ===\n" + user_text.strip())
    parts.append(SPEC_TASK)
    return "\n\n".join(parts)


def build_question_prompt(user_text: str | None, current: dict | None,
                          grants: dict) -> str:
    """§8 question call — the ordinary context stack (framework + grants + build
    instructions + spec + current steps) closed by the user's QUESTION and a
    plain-prose TASK. Read-only: the response is the answer, no envelope."""
    parts = [_FRAMEWORK_SECTION, *_common_context(current, grants)]
    parts.append("=== SPEC (spec.md) ===\n" + spec_as_md(current))
    for s in (current or {}).get("steps", []):
        parts.append(f"=== CURRENT step {s.get('file')} ({s.get('name')}) ===\n{s.get('code', '')}")
    parts.append("=== QUESTION ===\n" + (user_text or "").strip())
    parts.append(QUESTION_TASK)
    return "\n\n".join(parts)


def build_steps_prompt(mode: str, spec_md: str, current: dict | None,
                       grants: dict) -> str:
    """§8 call 2 — framework + build instructions + spec → manifest + step files."""
    parts = [_FRAMEWORK_SECTION, STEPS_TASK, *_common_context(current, grants)]
    if mode == "create":
        parts.append("=== MODE ===\ncreate — include a suggested `name` in manifest.yaml.")
    else:
        parts.append(f"=== MODE ===\n{mode} — the CURRENT files below are today's implementation; "
                     "rewrite them to match the SPEC, changing no more than the spec demands.")
        if current:
            parts.append("=== CURRENT param definitions ===\n"
                         + yaml.safe_dump(current.get("params", []), sort_keys=False))
            for s in current.get("steps", []):
                parts.append(f"=== CURRENT step {s.get('file')} ({s.get('name')}) ===\n{s.get('code', '')}")
    parts.append("=== SPEC (spec.md — implement this exactly) ===\n" + (spec_md or "").strip())
    parts.append(STEPS_REMINDER)
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


def parse_blockers(text: str) -> list[dict] | None:
    """§8 blocker envelope. None when the response isn't one; the parsed nonempty
    blocker list when it is; ValueError when it is one but malformed (which sends
    it through the normal repair round like any invalid response)."""
    m = BLOCKED_MARK_RE.search(text)
    if not m:
        return None
    if "===END===" not in text:
        raise ValueError("blocker response is truncated — no ===END=== marker")
    if FILE_MARK_RE.search(text):
        raise ValueError("a blocker envelope must not carry file blocks — return one or the other")
    try:
        data = yaml.safe_load(text[m.end(): text.index("===END===")])
    except yaml.YAMLError as e:
        raise ValueError(f"blocker envelope doesn't parse as yaml: {e}")
    blockers = data.get("blockers") if isinstance(data, dict) else None
    if not isinstance(blockers, list) or not blockers:
        raise ValueError("the blocker envelope needs a nonempty `blockers` list")
    out = []
    for b in blockers:
        if not isinstance(b, dict) or not str(b.get("reason") or "").strip() \
                or not str(b.get("fix") or "").strip():
            raise ValueError("every blocker needs a nonempty reason and fix")
        out.append({"reason": str(b["reason"]).strip(), "fix": str(b["fix"]).strip(),
                    "details": str(b.get("details") or "").strip()})
    return out


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

    # §6.2/§8: declared packages — {pip, import}, bare distribution name,
    # beyond stdlib/curated only. Their import names extend the step allowlist below.
    raw_pkgs = manifest.get("packages") or []
    norm_pkgs: list[dict] = []
    if not isinstance(raw_pkgs, list):
        errors.append("packages must be a list of { pip, import } entries")
        raw_pkgs = []
    for e in raw_pkgs:
        if not isinstance(e, dict) or not e.get("pip") or not e.get("import"):
            errors.append(f"packages entry malformed: {e!r} — need {{ pip: name, import: module }}")
            continue
        name, imp = str(e["pip"]).strip(), str(e["import"]).strip()
        if not pkglib.PIP_NAME_RE.match(name):
            errors.append(f"packages: {name!r} must be a bare distribution name — no version specifier")
        if not imp.isidentifier():
            errors.append(f"packages: import {imp!r} isn't a valid module name")
        elif imp in ALLOWED_IMPORTS:
            errors.append(f"packages: {imp} is already available — don't declare it")
        norm_pkgs.append({"pip": name, "import": imp})
    pkg_imports = [p["import"] for p in norm_pkgs]

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
            for mod in disallowed_imports(code, pkg_imports):
                errors.append(f"{s.get('file')}: import {mod} isn't allowed")
        except SyntaxError as e:
            errors.append(f"{s.get('file')}: syntax error — {e.msg} (line {e.lineno})")
        norm_steps.append({
            "file": s.get("file"), "name": s.get("name", ""), "desc": s.get("desc", ""),
            "agent": bool(s.get("agent")), "why": s.get("why", ""), "code": code,
        })
    trigs = manifest.get("triggers") or []
    norm_trigs: list[dict] = []
    if not isinstance(trigs, list):
        errors.append("triggers must be a list of { cron: expr } entries")
    else:
        for t in trigs:
            # §8: cron-only — one-shot and message triggers are never drafted.
            if not isinstance(t, dict) or not (set(t) == {"cron"} or set(t) == {"cron", "tz"}):
                errors.append(f"triggers entry {t!r} must be {{ cron: expr }} or {{ cron: expr, tz: zone }}")
                continue
            entry = {"kind": "cron", "expr": str(t["cron"]).strip(), "off": False}
            if "tz" in t:
                entry["tz"] = str(t["tz"])
                if err := schedule.tz_error(entry["tz"]):
                    errors.append(f"triggers: {err}")
                    continue
            try:
                schedule.parse_cron(entry["expr"])
                norm_trigs.append(entry)
            except schedule.CronError as e:
                errors.append(f"triggers: {e}")
    if errors:
        return {}, errors
    # No triggers key -> no triggers (manual / menu bar only).
    draft = {
        "triggers": norm_trigs,
        "name": manifest.get("name"),
        "desc": manifest.get("desc", ""),
        "note": manifest.get("note", ""),
        "params": params,
        "packages": norm_pkgs,
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
        stage = ("Answering the question" if mode == "question"
                 else "Writing the spec" if mode in ("create", "edit")
                 else "Generating the steps")
        job = {"id": job_id, "status": "building", "stage": stage, "detail": None,
               "error": None, "draft": None, "mode": mode, "_cancel": False, "_proc": {}}
        with self._lock:
            # Terminal jobs hold full draft payloads (all step code) — keep only
            # a recent tail so the process doesn't grow for its whole lifetime.
            terminal = [k for k, v in self.jobs.items() if v["status"] != "building"]
            for k in terminal[:-20]:
                del self.jobs[k]
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
            # A cancel racing completion must not clobber a terminal
            # done/blocked/failed job — the Review page would lose the result.
            if not j or j["status"] != "building":
                return False
            j["_cancel"] = True
            j["status"] = "cancelled"
        proc = j["_proc"].get("proc")
        if proc and proc.poll() is None:
            proc.terminate()
        hub.publish("draft.progress", jobId=job_id, status="cancelled", stage=None)
        return True

    def _settle(self, job: dict, status: str, **fields) -> bool:
        """The only terminal transition — building → done/blocked/failed under
        the lock, so a cancel that already won can never be overwritten (and
        vice versa)."""
        with self._lock:
            if job["status"] != "building":
                return False
            job["status"] = status
            job.update(fields)
            return True

    def _run(self, job: dict, mode: str, agent: dict, user_text: str | None,
             current: dict | None, grants: dict) -> None:
        try:
            cancelled = self._pipeline(job, mode, agent, user_text, current, grants)
            if cancelled:
                return
        except harness.HarnessError as e:
            self._settle(job, "failed", error=str(e))
        except Exception as e:  # noqa: BLE001
            # Anything else must still end the job — a thread dying here would
            # leave it "building" forever and the UI spinning.
            log.exception("drafting job %s crashed", job["id"])
            self._settle(job, "failed", error=f"drafting failed unexpectedly: {e}")
        if job["status"] == "cancelled":
            return  # cancel() already published its own terminal event
        hub.publish("draft.progress", jobId=job["id"], status=job["status"],
                    stage=None, error=job.get("error"))

    def _pipeline(self, job: dict, mode: str, agent: dict, user_text: str | None,
                  current: dict | None, grants: dict) -> bool:
        """Makes the mode's calls; sets job status. Returns True when cancelled mid-flight."""
        if mode == "question":
            # §8 question call: one read-only call, the raw response IS the
            # answer — no envelope, no blocker path, no repair round.
            raw = harness.invoke(agent, build_question_prompt(user_text, current, grants),
                                 timeout=300, proc_holder=job["_proc"],
                                 on_chunk=self._answer_cb(job))
            if job["_cancel"]:
                return True
            answer = raw.strip()
            if not answer:
                return self._fail(job, "The agent returned an empty answer.", [])
            self._settle(job, "done", draft={"answer": answer})
            return False

        spec_blocks = None
        if mode in ("create", "edit"):
            # ---- call 1: the spec ----
            spec, errors, blockers = self._call_with_repair(
                job, agent, build_spec_prompt(mode, user_text, current, grants), validate_spec)
            if job["_cancel"]:
                return True
            if blockers:
                return self._block(job, "spec", blockers, None)
            if errors:
                return self._fail(job, "The spec didn't validate — try again or rephrase.", errors)
            spec_md, spec_blocks = spec["md"], spec["blocks"]
            if mode == "create":
                # §11 drafting-on-Review: the validated spec rides the job
                # payload the moment call 1 lands, so the spec card can render
                # it while the steps call is still working (§19).
                job["draft"] = {"spec": spec_blocks}
            if mode == "edit":
                # §8: edit stops after the spec — the Review page shows the
                # rewritten spec out of sync and a later `sync` job rebuilds
                # the steps.
                self._settle(job, "done", draft={"spec": spec_blocks})
                return False
        else:
            # sync: the provided spec IS the input — no spec call
            spec_md = spec_as_md(current)

        # ---- call 2: steps, params, schedule ----
        self._stage(job, "Generating the steps")
        draft, errors, blockers = self._call_with_repair(
            job, agent, build_steps_prompt(mode, spec_md, current, grants), validate_steps)
        if job["_cancel"]:
            return True
        if blockers:
            # Hand call 1's spec along (create) so the §11 Blocker panel can
            # amend it and rebuild — on sync the caller already holds the spec.
            return self._block(job, "steps",
                               blockers, {"spec": spec_blocks} if spec_blocks else None)
        if errors:
            return self._fail(job, "The steps didn't validate — try again or rephrase.", errors)

        if draft.get("packages") and not job["_cancel"]:
            # §8: ensure the declared packages right after the steps land — the
            # user learns about an install failure on the edit page, not when a
            # trigger fires. A failure never fails the job (§6.2): the statuses
            # ride the draft payload and render in the §11 Packages card.
            self._stage(job, "Installing the packages")
            draft["packages"] = pkglib.ensure(
                draft["packages"],
                on_progress=lambda spec: self._detail(job, f"Installing {spec}…"))
            if job["_cancel"]:
                return True

        draft["spec"] = spec_blocks  # None on sync — the spec never changes there
        if mode == "create":
            # Hand the (seeded or user-given) instructions back so the
            # Review card arrives pre-filled — agents never return them.
            draft["instr"] = (current or {}).get("instr") or ""
        self._settle(job, "done", draft=draft)
        return False

    def _call_with_repair(self, job: dict, agent: dict, prompt: str,
                          validator) -> tuple[dict, list[str], list[dict] | None]:
        """One harness call + one automatic repair round against `validator`.
        A valid §8 blocker envelope is terminal — returned as-is, no repair.
        `_cancel` is checked before every invoke: a cancel between calls must
        never let a fresh 5-minute harness call start (nothing would kill it)."""
        if job["_cancel"]:
            return {}, [], None
        raw = harness.invoke(agent, prompt, timeout=300, proc_holder=job["_proc"],
                             on_chunk=self._progress_cb(job))
        if job["_cancel"]:
            return {}, [], None
        result, errors, blockers = self._parse_validate(raw, validator)
        if errors and not job["_cancel"]:
            repair = (prompt + "\n\n=== YOUR PREVIOUS RESPONSE ===\n" + raw
                      + "\n\n=== VALIDATION ERRORS — fix these and resend the full envelope ===\n- "
                      + "\n- ".join(errors))
            self._detail(job, "The response didn't validate — asking for a corrected one…")
            raw2 = harness.invoke(agent, repair, timeout=300, proc_holder=job["_proc"],
                                  on_chunk=self._progress_cb(job, prefix="Second try — "))
            if job["_cancel"]:
                return {}, [], None
            result, errors, blockers = self._parse_validate(raw2, validator)
        return result, errors, blockers

    def _progress_cb(self, job: dict, prefix: str = ""):
        """§8 live progress: accumulate the streamed response and derive the
        job's `detail` line from its ===FILE: markers. Marker changes publish
        immediately; line-count growth throttles to one publish per second."""
        state = {"text": "", "shape": None, "last": 0.0, "total": None}

        def cb(chunk: str) -> None:
            if job["_cancel"] or job["status"] != "building":
                return
            state["text"] += chunk
            text = state["text"]
            marks = list(FILE_MARK_RE.finditer(text))
            if not marks:
                shape = detail = "Thinking…"
            else:
                m = marks[-1]
                fname = m.group(1).strip()
                shape = fname
                if fname == "manifest.yaml":
                    detail = "Writing the manifest — name, triggers, parameters, step list"
                else:
                    lines = len(text[m.end():].strip("\n").splitlines())
                    if fname == "spec.md":
                        label = "the spec"
                    else:
                        total = self._steps_total(state, text, marks)
                        sm = STEP_FILE_RE.match(fname)
                        label = (f"step {int(sm.group(1))} of {total} — {fname}"
                                 if sm and total else fname)
                    count = f" · {lines} line{'s' if lines != 1 else ''}" if lines else ""
                    detail = f"Writing {label}{count}"
            now = time.monotonic()
            if shape != state["shape"] or now - state["last"] >= 1.0:
                state["shape"] = shape
                state["last"] = now
                if prefix:
                    detail = prefix + detail[0].lower() + detail[1:]
                self._detail(job, detail)

        return cb

    def _answer_cb(self, job: dict):
        """§8 question-call live progress: `Thinking…` until text arrives, then
        `Writing the answer · N lines` — shape changes publish immediately,
        line-count growth throttles to one publish per second."""
        state = {"text": "", "shape": None, "last": 0.0}

        def cb(chunk: str) -> None:
            if job["_cancel"] or job["status"] != "building":
                return
            state["text"] += chunk
            body = state["text"].strip()
            if not body:
                shape = detail = "Thinking…"
            else:
                shape = "answer"
                lines = len(body.splitlines())
                detail = f"Writing the answer · {lines} line{'s' if lines != 1 else ''}"
            now = time.monotonic()
            if shape != state["shape"] or now - state["last"] >= 1.0:
                state["shape"] = shape
                state["last"] = now
                self._detail(job, detail)

        return cb

    @staticmethod
    def _steps_total(state: dict, text: str, marks: list) -> int | None:
        """Step count from the streamed manifest block, once a later marker
        proves the block is complete. Parsed once, cached; None until then."""
        if state["total"] is None:
            for i, m in enumerate(marks[:-1]):  # only closed blocks
                if m.group(1).strip() == "manifest.yaml":
                    try:
                        manifest = yaml.safe_load(text[m.end():marks[i + 1].start()])
                        steps = manifest.get("steps") if isinstance(manifest, dict) else None
                        state["total"] = len(steps) if isinstance(steps, list) and steps else None
                    except yaml.YAMLError:
                        pass
                    break
        return state["total"]

    def _stage(self, job: dict, label: str) -> None:
        job["stage"] = label
        job["detail"] = None
        hub.publish("draft.progress", jobId=job["id"], status="building", stage=label,
                    detail=None)

    def _detail(self, job: dict, text: str) -> None:
        if job.get("detail") == text:
            return
        job["detail"] = text
        hub.publish("draft.progress", jobId=job["id"], status="building",
                    stage=job["stage"], detail=text)

    def _fail(self, job: dict, msg: str, errors: list[str]) -> bool:
        self._settle(job, "failed", error=msg, errorDetail=errors[:8])
        return False

    def _block(self, job: dict, at: str, blockers: list[dict], draft: dict | None) -> bool:
        # §8: a valid blocker envelope is its own terminal outcome, not a failure.
        self._settle(job, "blocked", blockedAt=at, blockers=blockers, draft=draft)
        return False

    @staticmethod
    def _parse_validate(raw: str, validator) -> tuple[dict, list[str], list[dict] | None]:
        try:
            blockers = parse_blockers(raw)
            if blockers is not None:
                return {}, [], blockers
            files = parse_envelope(raw)
        except ValueError as e:
            return {}, [str(e)], None
        result, errors = validator(files)
        return result, errors, None


draft_jobs = DraftJobs()
