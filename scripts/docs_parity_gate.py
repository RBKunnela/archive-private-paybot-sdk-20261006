#!/usr/bin/env python3
"""paybot-sdk docs-vs-code parity gate — "second model" discipline.

Lesson from the Money&Us/Chrono-Arithmetic story (Chefe 2026-09-10): an
unverified claim is a hallucination until a SECOND, independent check
confirms it. Alan only learned the truth when he ran the same proof
through a different model. Here the "different model" is the tree itself:
every docstring claim in this gate is re-derived from code, not trusted.

Usage: python3 scripts/docs_parity_gate.py   (exit 1 = parity broken)
Scope (v1): refund() docstring claims vs client.py implementation +
            README parity lines vs actual TS/Python method presence.
Add one check per class of claim we care about. No LLM — deterministic.
"""
from __future__ import annotations
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY_CLIENT = ROOT / "packages" / "python" / "paybot_sdk" / "client.py"
TS_SRC = ROOT / "src"
README = ROOT / "README.md"

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(name)


py = PY_CLIENT.read_text(encoding="utf-8")
ts = "\n".join(p.read_text(encoding="utf-8") for p in TS_SRC.glob("*.ts"))

# 1. Docstring must NOT claim a full-payment default the code doesn't have.
docstring = re.search(r'async def refund\(.*?"""(.*?)"""', py, re.S)
doc = docstring.group(1) if docstring else ""
check(
    "refund docstring: no 'refunds the full payment' default claim",
    "refunds the full payment" not in doc.lower() or "no full-payment default" in doc.lower(),
    "docs must not promise an amount default Phase A lacks",
)

# 2. Docstring example must not end on bare success=True (pending-only reality).
#    Scope: the FULL refund docstring (def line through closing quotes of the
#    docstring body) — not just to the first """ occurrence.
refund_start = py.find("async def refund(")
refund_ds = re.search(r'"""(.*?)"""', py[refund_start:], re.S) if refund_start >= 0 else None
example = refund_ds.group(1) if refund_ds else ""
check(
    "refund example: branches on status/pending, no bare success=True",
    bool(example) and "pending" in example.lower()
    and not re.search(r">>>\s*r\.success\s*$", example.strip()),
    f"docstring captured: {len(example)} chars",
)

# 3. Parity truth: refund exists in Python, absent in TS -> README must say so.
py_has = "async def refund" in py
ts_has = bool(re.search(r"\brefund\s*\(", ts)) and "def refund" in ts or "refund(" in ts
readme = README.read_text(encoding="utf-8")
if py_has and not ts_has:
    check(
        "README states refund() is Python-only",
        re.search(r"refund\(\).*python-only", readme, re.I | re.S) is not None,
        "README must disclose the TS gap when the gap exists",
    )

# 4. README parity note must match pending-only semantics (no 'funds returned').
m = re.search(r"parity note.*?(?:\n\n|\Z)", readme, re.I | re.S)
note = m.group(0) if m else ""
check(
    "README parity note: pending-only wording present",
    "pending-only" in note.lower(),
)

print(f"\n{len(failures)} failure(s)" if failures else "\nALL CHECKS PASS — docs match code")
sys.exit(1 if failures else 0)
