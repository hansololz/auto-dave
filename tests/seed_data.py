"""Seed / demo data (§16) — the prototype's four automations, two secrets, and
twelve executions covering every status. Test fixture data only; step code is
illustrative (drafted-by-an-agent style), not guaranteed runnable.

Lives in tests/ — the shipped app has no seed path and starts empty.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta

from autodave import keychain
from autodave.storage import Store


def _mk_ver(desc, params, steps, spec, instr=None, note=None):
    return {"desc": desc, "params": params, "steps": steps, "spec": spec,
            "instr": instr, "note": note}


def seed(store: Store) -> None:
    if store.autos:
        return

    now = datetime.now()

    # ---------- secrets (values → Keychain; names → secrets.yaml) ----------
    for name, value in [("SMTP_PASSWORD", "mail-app-2291-kx7f"), ("VAULT_DRIVE_KEY", "bk-2f91-aa07-51d3")]:
        keychain.set_secret(name, value)
        if name not in store.secret_names:
            store.secret_names.append(name)
    store.save_secret_names()

    # ---------- agents ----------
    if not store.agents:
        store.agents = [{"id": "claude", "name": None, "harness": "Claude Code",
                         "mode": "default", "model": "Claude Sonnet 4.5", "default": True}]
        store.save_agents()
    agent_id = next((a["id"] for a in store.agents if a.get("default")), store.agents[0]["id"])

    # ---------- Track manga chapters ----------
    manga_params = [
        {"name": "manga_list", "kind": "list", "label": "Manga list",
         "help": "One link per line — the manga pages to watch.", "validate": True, "default": []},
        {"name": "notify_only_on_changes", "kind": "toggle", "label": "Notify only on changes",
         "help": "Skip the morning notification when nothing is new.", "default": True},
        {"name": "chapters_kept_in_history", "kind": "number", "label": "Chapters kept in history",
         "help": "How many past chapters to remember per manga.", "min": 1, "default": 5},
        {"name": "notification_title", "kind": "text", "label": "Notification title",
         "help": "Shown at the top of the notification. Uses the automation name if empty.",
         "placeholder": "Track manga chapters", "default": ""},
        {"name": "display_names", "kind": "kv", "label": "Display names",
         "help": "Show a shorter name for long titles in the result table.", "default": []},
    ]
    manga_steps = [
        {"file": "01-read-your-manga-list.py", "name": "Read your manga list",
         "desc": "Loads the list, checks each line is a real link, and skips ones that aren't.",
         "code": 'import json\n'
                 'lines = [l.strip() for l in params["manga_list"] if l.strip()]\n'
                 'links = [l for l in lines if l.startswith("http")]\n'
                 'skipped = [l for l in lines if not l.startswith("http")]\n'
                 'if skipped:\n    log.warn(f"{len(skipped)} line(s) skipped — not links")\n'
                 'json.dump(links, open("links.json", "w"))  # workspace hands step 2 the list\n'},
        {"file": "02-check-each-site-for-new-chapters.py", "name": "Check each site for new chapters",
         "desc": "Visits each manga's page and has an agent read off the newest chapter number and title.",
         "agent": True, "agent_id": None,
         "why": "Manga sites all lay out their pages differently — plain code can't reliably find the newest chapter in arbitrary HTML. The agent reads each page and returns just the chapter info.",
         "code": 'import json\nlinks = json.load(open("links.json"))\nfound = []\n'
                 'for url in links:\n    page = fetch_page(url)                     # plain HTTP GET\n'
                 '    latest = agent.read(page[:5000],           # sites all differ — the agent\n'
                 '        "newest chapter: number, title, date") # reads the page like a person\n'
                 '    found.append({"url": url, "latest": latest})\n'
                 'json.dump(found, open("found.json", "w"))\n'},
        {"file": "03-compare-with-memory.py", "name": "Compare with memory",
         "desc": "Looks at the last chapter seen for each manga to decide what counts as new.",
         "code": 'import json\nfound = json.load(open("found.json"))\n'
                 'last_seen = memory.load("last_seen", {})\nfor f in found:\n'
                 '    last = last_seen.get(f["url"])\n'
                 '    f["is_new"] = last is not None and f["latest"] != last\n'
                 '    last_seen[f["url"]] = f["latest"]  # remembered for next run\n'
                 'memory.save("last_seen", last_seen)\n'
                 'json.dump(found, open("found.json", "w"))\n'},
        {"file": "04-notify-and-build-the-result.py", "name": "Notify and build the result",
         "desc": "Sends the notification (only on changes) and builds the morning table.",
         "code": 'import json\nfound = json.load(open("found.json"))\n'
                 'fresh = [f for f in found if f["is_new"]]\n'
                 'if fresh or not params["notify_only_on_changes"]:\n'
                 '    notify(f"{len(fresh)} new chapters")\n'
                 'result.status("changes" if fresh else "ok")\n'
                 'result.chip(f"{len(fresh)} new chapters" if fresh else "No new chapters")\n'
                 'result.value("New chapters", [f["latest"] for f in fresh])\n'
                 'rows = "\\n".join(f"| {f[\'url\']} | {f[\'latest\']} | {\'NEW\' if f[\'is_new\'] else \'—\'} |" for f in found)\n'
                 '(result / "result.md").write_text("| Manga | Latest chapter | New |\\n|---|---|---|\\n" + rows)\n'},
    ]
    manga_spec = [
        {"k": "h1", "text": "Track manga chapters"},
        {"k": "p", "text": "Checks each manga in your list every morning and tells you when new chapters are out."},
        {"k": "h2", "text": "Schedule"},
        {"k": "p", "text": "Every day at 8:00."},
        {"k": "h2", "text": "What it does"},
        {"k": "li", "text": "Reads your manga list and skips lines that aren't links."},
        {"k": "li", "text": "Visits each manga's page and finds the newest chapter."},
        {"k": "li", "text": "Compares with the last chapter it saw for each manga."},
        {"k": "li", "text": "Notifies you and builds a table of what's new."},
        {"k": "h2", "text": "Settings"},
        {"k": "li", "text": "Manga list — the pages to watch, one per line."},
        {"k": "li", "text": "Notify only on changes — skip the notification when nothing is new."},
        {"k": "h2", "text": "Change (v3)"},
        {"k": "p", "text": "Added display names so long titles stay readable in the table."},
    ]
    manga_instr = ("Prefer Python for scripts.\nNever delete anything — move files to the Trash instead.\n"
                   "Never pass a secret as the input for an agent.\nKeep it to one notification per run.")
    manga = store.create_automation(
        _mk_ver("Checks the manga you follow every morning and tells you when new chapters are out.",
                manga_params, manga_steps, manga_spec, instr=manga_instr, note="Created"),
        "Track manga chapters", agent_id, hour=8)
    # older versions v2 (v1 base), then current becomes v3
    v2_spec = [b for b in manga_spec if not (b["k"] == "h2" and b["text"].startswith("Change"))
               and b["text"] != "Added display names so long titles stay readable in the table."]
    store.save_new_version(manga, _mk_ver(manga["versions"][1]["desc"], manga_params, manga_steps,
                                          v2_spec + [{"k": "h2", "text": "Change (v2)"},
                                                     {"k": "p", "text": "The table now links straight to the newest chapter."}],
                                          instr=manga_instr,
                                          note="Skip list lines that aren't links instead of failing."))
    store.save_new_version(manga, _mk_ver(manga["versions"][1]["desc"], manga_params, manga_steps,
                                          manga_spec, instr=manga_instr,
                                          note="Added display names so long titles stay readable in the table."))
    store.patch_automation(manga, {"paramValues": {
        "manga_list": ["https://mangaplus.shueisha.co.jp/titles/100020",
                       "https://comikey.com/comics/kagurabachi",
                       "https://mangadex.org/title/vinland-saga",
                       "https://mangadex.org/title/berserk",
                       "one punch man new site??",
                       "https://mangadex.org/title/dandadan",
                       "https://mangadex.org/title/frieren"],
        "notify_only_on_changes": True,
        "chapters_kept_in_history": 5,
        "notification_title": "",
        "display_names": [{"k": "mangadex.org/title/frieren", "v": "Frieren"},
                          {"k": "comikey.com/comics/kagurabachi", "v": "Kagurabachi"}],
    }})
    (store.auto_dir(manga) / "memory").mkdir(exist_ok=True)
    (store.auto_dir(manga) / "memory" / "last_seen.yaml").write_text(
        "https://mangaplus.shueisha.co.jp/titles/100020: 'Ch. 1145'\n", encoding="utf-8")

    # ---------- Nightly folder backup ----------
    backup_steps = [
        {"file": "01-find-files-changed-since-last-night.py", "name": "Find files changed since last night",
         "desc": "Compares file dates against the last run.",
         "code": 'import json, os\nlast = memory.load("last_run_at", 0)\nchanged = []\n'
                 'for root, _, files in os.walk(os.path.expanduser(params["folder_to_back_up"])):\n'
                 '    if params["skip_node_modules_folders"] and "node_modules" in root: continue\n'
                 '    for f in files:\n        p = os.path.join(root, f)\n'
                 '        if os.path.getmtime(p) > last: changed.append(p)\n'
                 'log(f"{len(changed)} files changed")\n'
                 'json.dump(changed, open("changed.json", "w"))\n'},
        {"file": "02-copy-them-to-the-backup-drive.py", "name": "Copy them to the backup drive",
         "desc": "Unlocks the Vault drive with its key from the Keychain, then copies with checksums so a bad copy is caught immediately.",
         "code": 'import json, os, shutil\nchanged = json.load(open("changed.json"))\n'
                 'key = secrets.VAULT_DRIVE_KEY  # never logged\n'
                 'dest = params["backup_destination"]\n'
                 'if not os.path.isdir(dest):\n'
                 '    raise RuntimeError(f"backup destination {dest} isn\'t mounted")\n'
                 'for f in changed:\n'
                 '    shutil.copy2(f, os.path.join(dest, os.path.basename(f)))\n'
                 'log(f"{len(changed)} of {len(changed)} copied · checksums ok")\n'},
        {"file": "03-prune-old-copies.py", "name": "Prune old copies",
         "desc": "Keeps the newest N nightly copies and removes the rest.",
         "code": 'keep = params["copies_to_keep"]\nlog(f"keeping the newest {keep} copies")\n'
                 'import time\nmemory.save("last_run_at", time.time())\n'
                 'result.status("ok")\nresult.chip("All good")\n'
                 'result.value("Summary", "Projects is fully backed up to the Vault drive.")\n'},
    ]
    backup_params = [
        {"name": "folder_to_back_up", "kind": "text", "label": "Folder to back up",
         "help": "Everything inside is watched for changes.", "default": "~/Projects"},
        {"name": "backup_destination", "kind": "text", "label": "Backup destination",
         "help": "Where the copies go.", "default": "/Volumes/Vault/Backups"},
        {"name": "copies_to_keep", "kind": "number", "label": "Copies to keep",
         "help": "Older nightly copies are pruned past this count.", "min": 1, "default": 7},
        {"name": "skip_node_modules_folders", "kind": "toggle", "label": "Skip node_modules folders",
         "help": "Saves a lot of space if you write code.", "default": True},
    ]
    backup_spec = [
        {"k": "h1", "text": "Nightly folder backup"},
        {"k": "p", "text": "Copies changed files from Projects to the Vault drive every night at 2:00, keeping the last 7 copies."},
        {"k": "h2", "text": "Change (v2)"},
        {"k": "p", "text": "Copies are now verified with checksums."},
    ]
    backup = store.create_automation(
        _mk_ver("Copies changed files from Projects to the backup drive every night.",
                backup_params, backup_steps, backup_spec[:2]),
        "Nightly folder backup", agent_id, hour=2)
    store.save_new_version(backup, _mk_ver(backup["versions"][1]["desc"], backup_params, backup_steps,
                                           backup_spec, note="Copies are now verified with checksums."))
    store.patch_automation(backup, {"allowedSecrets": ["VAULT_DRIVE_KEY"]})

    # ---------- Weekly report email ----------
    report_steps = [
        {"file": "01-gather-the-weeks-numbers.py", "name": "Gather the week's numbers",
         "desc": "Reads the four tracking sheets.",
         "code": 'import json\nrows = memory.load("sources", [])  # 4 sources\n'
                 'log(f"{len(rows) or 4} sources read · 28 rows")\n'
                 'json.dump(rows, open("rows.json", "w"))\n'},
        {"file": "02-write-the-summary.py", "name": "Write the summary",
         "desc": "Has an agent turn the numbers into a short readable summary.",
         "agent": True, "agent_id": None,
         "why": "Writing readable prose from raw numbers is judgment, not rules — the agent drafts the summary from the week's rows. The gathering and sending around it stay plain code.",
         "code": 'import json\nrows = json.load(open("rows.json"))\n'
                 'summary = agent.write(rows,\n    "3–4 sentences — what changed this week and why it matters")\n'
                 'open("summary.txt", "w").write(summary)\n'},
        {"file": "03-send-the-email.py", "name": "Send the email",
         "desc": "Sends via your mail account. The password comes from the Keychain.",
         "code": 'import smtplib\nsummary = open("summary.txt").read()\n'
                 'password = secrets.SMTP_PASSWORD  # never logged\n'
                 'log("connecting to smtp.fastmail.com…")\n'
                 'with smtplib.SMTP("smtp.fastmail.com", 587, timeout=15) as s:\n'
                 '    s.starttls()\n    s.login("me", password)\n'
                 'result.status("ok")\nresult.chip("Email sent")\n'},
        {"file": "04-record-the-send.py", "name": "Record the send",
         "desc": "Notes what was sent, for next week's comparison.",
         "code": 'import json, time\nrows = json.load(open("rows.json"))\n'
                 'memory.save("last_sent", {"at": time.time(), "rows": len(rows)})\n'},
    ]
    report_params = [
        {"name": "recipients", "kind": "list", "label": "Recipients",
         "help": "One address per line.", "validate": False, "default": []},
        {"name": "subject_line", "kind": "text", "label": "Subject line",
         "help": "The week's dates are added automatically.", "default": "Weekly numbers"},
        {"name": "attach_the_spreadsheet", "kind": "toggle", "label": "Attach the spreadsheet",
         "help": "Includes the raw numbers as a file.", "default": True},
    ]
    report_spec = [
        {"k": "h1", "text": "Weekly report email"},
        {"k": "p", "text": "Every Monday at 9:00, gathers the week's numbers, writes a short summary and emails it to the team."},
        {"k": "h2", "text": "Change (v5)"},
        {"k": "p", "text": "The spreadsheet attachment is now optional."},
    ]
    report = store.create_automation(
        _mk_ver("Gathers the week's numbers and emails the summary every Monday morning.",
                report_params, report_steps, report_spec[:2]),
        "Weekly report email", agent_id, hour=9, dow=1)
    for note in ["Summary capped at roughly 200 words.",
                 "Added week-over-week comparison to the summary.",
                 "Send to the team alias instead of individual addresses.",
                 "The spreadsheet attachment is now optional."]:
        store.save_new_version(report, _mk_ver(report["versions"][1]["desc"], report_params,
                                               report_steps, report_spec, note=note))
    store.patch_automation(report, {
        "allowedSecrets": ["SMTP_PASSWORD"],
        "paramValues": {"recipients": ["team@northbeam.studio", "sam@northbeam.studio", "priya@northbeam.studio"],
                        "subject_line": "Weekly numbers", "attach_the_spreadsheet": True},
    })

    # ---------- Clean screenshots folder ----------
    shots_steps = [
        {"file": "01-find-screenshots-on-the-desktop.py", "name": "Find screenshots on the Desktop",
         "desc": "Matches the files macOS names “Screenshot …”.",
         "code": 'import json, os, re\ndesktop = os.path.expanduser("~/Desktop")\n'
                 'shots = [f for f in os.listdir(desktop) if re.match(r"^Screenshot ", f)]\n'
                 'log(f"{len(shots)} screenshots found")\n'
                 'json.dump(shots, open("shots.json", "w"))\n'},
        {"file": "02-file-them-into-monthly-folders.py", "name": "File them into monthly folders",
         "desc": "Creates a folder per month and moves them in.",
         "code": 'import json, os, shutil, datetime\n'
                 'desktop = os.path.expanduser("~/Desktop")\n'
                 'shots = json.load(open("shots.json"))\nfor s in shots:\n'
                 '    p = os.path.join(desktop, s)\n'
                 '    month = datetime.date.fromtimestamp(os.path.getctime(p)).strftime("%Y-%m")\n'
                 '    dest = os.path.join(desktop, month)\n    os.makedirs(dest, exist_ok=True)\n'
                 '    shutil.move(p, dest)\n'
                 'result.status("ok")\nresult.chip("All good")\n'
                 'result.value("Summary", f"The desktop is clean. {len(shots)} screenshots filed.")\n'},
    ]
    shots = store.create_automation(
        _mk_ver("Files desktop screenshots into monthly folders every Sunday night.",
                [{"name": "also_clean_the_downloads_folder", "kind": "toggle",
                  "label": "Also clean the Downloads folder",
                  "help": "Files loose screenshots from Downloads too.", "default": False}],
                shots_steps,
                [{"k": "h1", "text": "Clean screenshots folder"},
                 {"k": "p", "text": "Every Sunday night, files desktop screenshots into monthly folders."}]),
        "Clean screenshots folder", agent_id, hour=21, dow=0)

    # ---------- executions (12, every status) ----------
    P_ACCENT, P_GREEN, P_AMBER, P_ORANGE = "accent", "green", "amber", "orange"
    manga_result = {
        "status": "changes", "chip": "2 new chapters",
        "chips": ["6 manga checked", "2 new chapters"],
        "values": [
            {"name": "New chapters", "value": ["One Piece — Ch. 1145 · “The Weight of a Promise”",
                                               "Frieren — Ch. 142 · “The Golden Land”"]},
            {"name": "Manga checked", "value": "6"},
            {"name": "Unchanged", "value": "4"},
        ],
    }
    # §16: the manga table is a markdown table in result.md (READ column included).
    manga_result_md = "\n".join([
        "| Manga | Latest chapter | Updated | New | Read |",
        "|---|---|---|---|---|",
        "| [One Piece](https://mangaplus.shueisha.co.jp/titles/100020) | Ch. 1145 · “The Weight of a Promise” | 2h ago | **NEW** | Ch. 1143 |",
        "| [Frieren: Beyond Journey’s End](https://mangadex.org/title/frieren) | Ch. 142 · “The Golden Land” | 5h ago | **NEW** | Ch. 141 |",
        "| [Dandadan](https://mangadex.org/title/dandadan) | Ch. 189 | 2d ago | — | Ch. 189 |",
        "| [Kagurabachi](https://comikey.com/comics/kagurabachi) | Ch. 94 | 4d ago | — | Ch. 92 |",
        "| [Vinland Saga](https://mangadex.org/title/vinland-saga) | Ch. 218 | 6d ago | — | Ch. 218 |",
        "| [Berserk](https://mangadex.org/title/berserk) | Ch. 379 | 3w ago | — | Ch. 378 |",
    ])
    manga_logs = [
        ("sys", "▸ Step 1 — Read your manga list"),
        ("out", "7 lines · 6 valid links · 1 skipped (not a link)"),
        ("wrn", "line 5 isn’t a link — “one punch man new site??”"),
        ("sys", "▸ Step 2 — Check each site for new chapters"),
        ("out", "mangaplus.shueisha.co.jp · One Piece — Ch. 1145 “The Weight of a Promise”"),
        ("out", "comikey.com · Kagurabachi — Ch. 94"),
        ("out", "mangadex.org · Vinland Saga — Ch. 218"),
        ("out", "mangadex.org · Berserk — Ch. 379"),
        ("out", "mangadex.org · Dandadan — Ch. 189"),
        ("out", "mangadex.org · Frieren — Ch. 142 “The Golden Land”"),
        ("sys", "▸ Step 3 — Compare with memory"),
        ("out", "One Piece: 1144 → 1145 · new"),
        ("out", "Frieren: 141 → 142 · new"),
        ("out", "4 manga unchanged"),
        ("sys", "▸ Step 4 — Notify and build the result"),
        ("out", "notification sent — “2 new chapters”"),
        ("out", "result saved · run finished in 24.8s"),
    ]

    def put_exec(auto, ver, status, trigger, started, dur_ms, steps, logs, result=None,
                 note=None, redacted=None, files=None):
        h = store.create_execution(auto, ver, trigger,
                                   [{"name": n, "status": st, "dur_ms": d} for n, st, d in steps],
                                   note=note, status="running")
        h["started_at"] = started.isoformat(timespec="seconds")
        h["status"] = status
        h["dur_ms"] = dur_ms
        h["redacted"] = redacted or []
        if status in ("succeeded", "failed", "cancelled", "interrupted"):
            h["finished_at"] = (started + timedelta(milliseconds=dur_ms or 0)).isoformat(timespec="seconds")
        # Log lines carry the step they belong to ({ts, t, step, k, text}); a
        # "▸ Step N — name" sys marker belongs to that step, later lines inherit
        # it, and lines before any marker are run-level (step: null).
        step_names = [n for n, _, _ in steps]
        step_mark = re.compile(r"^▸ Step (\d+)")
        cur_step = None
        for i, (k, text) in enumerate(logs):
            m = step_mark.match(text)
            if k == "sys" and m and 0 < int(m.group(1)) <= len(step_names):
                cur_step = step_names[int(m.group(1)) - 1]
            t = (started + timedelta(seconds=1 + i * 2)).strftime("%H:%M:%S")
            store.append_log(h["id"], {"ts": started.isoformat(timespec="seconds"), "t": t,
                                       "step": cur_step, "k": k, "text": text})
        if result:
            store.write_result(h["id"], result)
        for name, content in (files or {}).items():
            (store.exec_dir(h["id"]) / "result" / name).write_text(content, encoding="utf-8")
        store.update_execution(h)
        return h

    today8 = now.replace(hour=8, minute=1, second=0, microsecond=0)
    if today8 > now:
        today8 -= timedelta(days=1)
    today2 = now.replace(hour=2, minute=3, second=0, microsecond=0)
    if today2 > now:
        today2 -= timedelta(days=1)
    monday9 = now.replace(hour=9, minute=0, second=0, microsecond=0) - timedelta(days=(now.weekday()) % 7)
    if monday9 > now:
        monday9 -= timedelta(days=7)

    manga_steps_ok = [("Read your manga list", "succeeded", 400),
                      ("Check each site for new chapters", "succeeded", 19600),
                      ("Compare with memory", "succeeded", 300),
                      ("Notify and build the result", "succeeded", 1100)]
    put_exec(manga, "v3", "succeeded", "Schedule", today8, 24800, manga_steps_ok, manga_logs, manga_result,
             files={"result.md": manga_result_md})
    put_exec(backup, "v2", "succeeded", "Schedule", today2, 41200,
             [("Find files changed since last night", "succeeded", 3900),
              ("Copy them to the backup drive", "succeeded", 35000),
              ("Prune old copies", "succeeded", 2300)],
             [("sys", "▸ Step 1 — Find files changed since last night"),
              ("out", "142 files changed · 1.8 GB"),
              ("sys", "▸ Step 2 — Copy them to the backup drive"),
              ("out", "142 of 142 copied · checksums ok"),
              ("sys", "▸ Step 3 — Prune old copies"),
              ("out", "removed the copy from Jun 30 · 7 kept")],
             {"status": "ok", "chip": "All good", "chips": ["142 files copied", "1.8 GB", "41 s"],
              "values": [{"name": "Summary", "value": "Projects is fully backed up to the Vault drive. Nothing unusual last night."}]})
    put_exec(report, "v5", "failed", "Schedule", monday9, 12400,
             [("Gather the week’s numbers", "succeeded", 5800),
              ("Write the summary", "succeeded", 3100),
              ("Send the email", "failed", 3500),
              ("Record the send", "queued", None)],
             [("sys", "▸ Step 1 — Gather the week’s numbers"),
              ("out", "4 sources read · 28 rows"),
              ("sys", "▸ Step 2 — Write the summary"),
              ("out", "summary drafted · 214 words"),
              ("sys", "▸ Step 3 — Send the email"),
              ("out", "connecting to smtp.fastmail.com…"),
              ("err", "sign-in failed — the server rejected the password (535)"),
              ("err", "the SMTP_PASSWORD secret may be out of date"),
              ("sys", "run failed at step 3 — nothing was sent")],
             {"status": "attention", "chip": "Needs attention", "chips": [],
              "values": [{"name": "What happened", "value": "Monday’s run couldn’t sign in to the mail server, so no email went out."},
                         {"name": "Next steps", "value": ["Update the SMTP_PASSWORD secret — the server rejected the current one.",
                                                          "Run it again — the email goes out as soon as a run succeeds."]}]},
             redacted=["SMTP_PASSWORD"])
    put_exec(manga, "v3", "succeeded", "Menu bar", today8 - timedelta(days=1, minutes=-13), 26100,
             manga_steps_ok, manga_logs,
             {"status": "changes", "chip": "1 new chapter", "chips": ["6 manga checked", "1 new chapter"],
              "values": [{"name": "New chapters", "value": ["One Piece — Ch. 1144"]},
                         {"name": "Unchanged", "value": "5"}]})
    put_exec(backup, "v2", "cancelled", "Schedule", today2 - timedelta(days=1), None, [], [],
             note="previous run still in progress")
    put_exec(manga, "v2", "succeeded", "Schedule", today8 - timedelta(days=5), 22900,
             [("Read your manga list", "succeeded", 400),
              ("Check each site for new chapters", "skipped", 20100),
              ("Compare with memory", "succeeded", 300),
              ("Notify and build the result", "succeeded", 900)],
             [("sys", "▸ Step 2 — Check each site for new chapters"),
              ("wrn", "mangadex.org didn’t respond after 3 tries — skipped"),
              ("out", "5 of 6 manga checked")],
             {"status": "attention", "chip": "5 of 6 checked",
              "chips": ["5 of 6 manga checked", "No new chapters"],
              "values": [{"name": "Summary", "value": "No new chapters among the 5 manga that were checked."},
                         {"name": "Skipped", "value": ["mangadex.org didn’t respond after 3 tries — skipped this run"]}]})
    put_exec(manga, "v2", "cancelled", "Schedule", today8 - timedelta(days=6), None, [], [],
             note="previous run still in progress")
    put_exec(manga, "v2", "cancelled", "Manual", now.replace(hour=15, minute=12) - timedelta(days=7), 8400,
             [("Read your manga list", "succeeded", 400),
              ("Check each site for new chapters", "cancelled", 7800),
              ("Compare with memory", "queued", None),
              ("Notify and build the result", "queued", None)],
             [("sys", "▸ Step 2 — Check each site for new chapters"),
              ("out", "run cancelled by you — nothing else will happen")])
    put_exec(shots, "v1", "interrupted", "Schedule", now.replace(hour=21, minute=0) - timedelta(days=11), 3100,
             [("Find screenshots on the Desktop", "interrupted", 3100),
              ("File them into monthly folders", "queued", None)],
             [("wrn", "the Mac went to sleep — the run will resume next Sunday")],
             note="Mac went to sleep")
    put_exec(report, "v4", "succeeded", "Schedule", monday9 - timedelta(days=7), 18300,
             [("Gather the week’s numbers", "succeeded", 6000),
              ("Write the summary", "succeeded", 3400),
              ("Send the email", "succeeded", 7700),
              ("Record the send", "succeeded", 400)],
             [("out", "email sent to 3 recipients")],
             {"status": "ok", "chip": "Email sent", "chips": ["3 recipients", "198 words"],
              "values": [{"name": "Summary", "value": "The weekly summary went out to the team at 9:00."}]},
             redacted=["SMTP_PASSWORD"])
    put_exec(shots, "v1", "succeeded", "Schedule", now.replace(hour=21, minute=0) - timedelta(days=4), 5200,
             [("Find screenshots on the Desktop", "succeeded", 1100),
              ("File them into monthly folders", "succeeded", 4100)],
             [("sys", "▸ Step 1 — Find screenshots on the Desktop"),
              ("out", "38 screenshots found"),
              ("sys", "▸ Step 2 — File them into monthly folders"),
              ("out", "38 filed into 2026-06")],
             {"status": "ok", "chip": "All good", "chips": ["38 screenshots filed"],
              "values": [{"name": "Summary", "value": "The desktop is clean. Screenshots went into 2026-06."}]})
    # one reused-status example: a rerun of the failed report where early steps were reused
    put_exec(report, "v5", "failed", "Manual", monday9 + timedelta(hours=2), 4200,
             [("Gather the week’s numbers", "reused", None),
              ("Write the summary", "reused", None),
              ("Send the email", "failed", 4200),
              ("Record the send", "queued", None)],
             [("sys", "▸ Step 3 — Send the email (steps 1–2 reused from the earlier run)"),
              ("err", "sign-in failed — the server rejected the password (535)")],
             redacted=["SMTP_PASSWORD"])
    store._refresh_exec_derived()
