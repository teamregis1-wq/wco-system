"""Frontend ↔ backend API compatibility.

Scans the Next.js source for every API path the frontend calls and checks
that a backend route with that method and path shape exists. Catches renamed
or removed endpoints before they reach the browser.
"""
import re
from pathlib import Path

import pytest

from app.main import app

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
PREFIX = "/api/v1"

# apiFetch<...>("/path", { method: "POST" ... })  /  fetch(`${API_BASE}/path`, { method: ... })
CALL = re.compile(
    r"""(?:apiFetch(?:<[^>]*(?:<[^>]*>[^>]*)*>)?\(\s*|fetch\(\s*`\$\{(?:API_BASE|BASE)\})"""
    r"""[`"'](?P<path>/[^`"'?]*)(?:\?[^`"']*)?[`"']"""
    # Look ahead (without consuming) up to the next call to find its `method:`.
    r"""(?=(?P<rest>(?:(?!apiFetch|fetch\().){0,240}))""", re.S)
METHOD = re.compile(r"""method:\s*["'](?P<m>[A-Z]+)["']""")


def _frontend_calls():
    calls = set()
    for f in list(FRONTEND.glob("app/**/*.tsx")) + list(FRONTEND.glob("components/*.tsx")) \
            + list(FRONTEND.glob("lib/*.ts*")):
        src = f.read_text(encoding="utf-8")
        # Normalise template-literal fetch(`${API_BASE}/x`) to the same quoting as apiFetch.
        src = re.sub(r"fetch\(`\$\{(API_BASE|BASE)\}(/[^`]*)`", r'fetch(`${\1}"\2"', src)
        for m in CALL.finditer(src):
            method = (METHOD.search(m.group("rest") or "") or {}) and METHOD.search(m.group("rest")).group("m")
            calls.add((method or "GET", m.group("path"), str(f.relative_to(FRONTEND))))
    return sorted(calls)


def _route_regexes():
    out = []
    for r in app.routes:
        path = getattr(r, "path", "")
        if not path.startswith(PREFIX):
            continue
        rx = "^" + re.sub(r"\{[^}]+\}", r"[^/]+", path[len(PREFIX):]) + "$"
        for m in getattr(r, "methods", set()):
            out.append((m, re.compile(rx)))
    return out


CALLS = _frontend_calls()


def test_scanner_finds_calls():
    assert len(CALLS) > 25, CALLS


@pytest.mark.parametrize("method,path,source", CALLS)
def test_frontend_call_has_backend_route(method, path, source):
    concrete = re.sub(r"\$\{[^}]+\}", "1", path)
    matches = [m for m, rx in _route_regexes() if rx.match(concrete)]
    assert matches, f"{source}: no backend route for {path}"
    assert method in matches, f"{source}: {method} {path} not allowed (backend has {matches})"
