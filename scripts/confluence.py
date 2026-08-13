#!/usr/bin/env python3
"""
Edit Confluence pages without retyping them.

WHY THIS EXISTS

Confluence has no partial-update endpoint: every change is a full-document PUT,
in the REST API and in the MCP tool alike. Through the MCP that means the whole
page has to pass through the model as text — about 35,000 tokens for the Backlog,
twice, to change one cell.

This does the same full PUT, but the document never leaves the machine. The
model runs a command; the bytes stay in a file. A one-cell edit costs a few
hundred tokens instead of tens of thousands.

It also works in ADF (the page's real structure) rather than HTML. That removes
a whole class of failure: on 13 Aug a markdown write broke a table row at a
literal \\n inside a code span and spilled six rows out of the table, and the
API returned 200 while doing it. JSON has no such parsing step.

CREDENTIALS

Read from ~/.netrc, so no token ever appears in a command, in shell history, or
in this repo:

    machine your-site.atlassian.net
    login you@example.com
    password <API token from id.atlassian.com>

    chmod 600 ~/.netrc

USAGE

    confluence.py get   PAGE_ID [-o FILE]     fetch (ADF), default /tmp/adf-PAGE_ID.json
    confluence.py rows  PAGE_ID               list the table's ticket rows
    confluence.py cell  PAGE_ID KEY COL       print one cell's text
    confluence.py put   PAGE_ID FILE -m MSG   upload an edited file

A FILE here is the whole `get` response, edited in place. `put` bumps the
version itself, so a stale file is rejected by the server rather than silently
overwriting someone else's change.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

SITE = "davinali723.atlassian.net"
API = "https://{site}/wiki/api/v2/pages/{page}"


# ── Transport ────────────────────────────────────────────────────────────────
#
# Through curl rather than urllib, for two reasons. Homebrew's Python ships no
# CA bundle, so urllib cannot verify Atlassian's certificate while curl uses the
# system store and just works. And `curl -n` reads ~/.netrc itself, so the token
# never passes through this process, never reaches a command line where `ps`
# could see it, and never lands in shell history.
#
# The body goes via a temp file for the same reason: a 100KB document as an
# argv entry would hit ARG_MAX long before the Backlog got interesting.

def request(method, url, payload=None):
    cmd = ["curl", "-sS", "-n", "-X", method,
           "-H", "Accept: application/json",
           "-w", "\n%{http_code}", url]
    tmp = None
    try:
        if payload is not None:
            fd, tmp = tempfile.mkstemp(suffix=".json")
            with os.fdopen(fd, "w") as fh:
                json.dump(payload, fh, ensure_ascii=False)
            cmd[-1:-1] = ["-H", "Content-Type: application/json", "--data", "@" + tmp]
        done = subprocess.run(cmd, capture_output=True, text=True)
    finally:
        if tmp:
            os.unlink(tmp)

    if done.returncode != 0:
        sys.exit(f"curl failed: {done.stderr.strip()}")
    raw, _, status = done.stdout.rpartition("\n")
    if not status.startswith("2"):
        sys.exit(f"HTTP {status} from Confluence:\n{raw[:600]}")
    return json.loads(raw) if raw.strip() else {}


def fetch(page_id):
    url = API.format(site=SITE, page=page_id) + "?body-format=atlas_doc_format"
    return request("GET", url)


def upload(page_id, page, message):
    """PUT the edited document, bumping the version we actually read."""
    adf = page["body"]["atlas_doc_format"]["value"]
    if not isinstance(adf, str):                 # convenience: allow a parsed doc
        adf = json.dumps(adf, ensure_ascii=False)
    payload = {
        "id": str(page_id),
        "status": page.get("status", "current"),
        "title": page["title"],
        "body": {"representation": "atlas_doc_format", "value": adf},
        # Reading v24 and writing v25 is what makes a concurrent edit a 409
        # rather than a silent overwrite.
        "version": {"number": page["version"]["number"] + 1, "message": message},
    }
    return request("PUT", API.format(site=SITE, page=page_id), payload)


# ── ADF helpers, importable by one-off patch scripts ─────────────────────────

def doc_of(page):
    return json.loads(page["body"]["atlas_doc_format"]["value"])


def set_doc(page, doc):
    page["body"]["atlas_doc_format"]["value"] = json.dumps(doc, ensure_ascii=False)


def node_text(node):
    if node.get("type") == "text":
        return node.get("text", "")
    return "".join(node_text(c) for c in node.get("content", []))


def first_table(doc):
    for node in doc.get("content", []):
        if node.get("type") == "table":
            return node
    raise SystemExit("No table on this page.")


def ticket_rows(doc, key_col=3):
    """{'ORB-74': rowNode} for every row whose key column holds an ORB number."""
    found = {}
    for row in first_table(doc)["content"]:
        cells = row.get("content", [])
        if len(cells) <= key_col:
            continue
        match = re.search(r"ORB-\d+", node_text(cells[key_col]))
        if match:
            found[match.group(0)] = row
    return found


# `**bold**`, `*italic*` and `` `code` `` — the three the Backlog cells use.
_INLINE = re.compile(r"(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)")


def inline_nodes(text):
    """Marker text to ADF inline nodes. The only writer of marks in this file."""
    out = []
    for part in _INLINE.split(str(text)):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            out.append({"type": "text", "text": part[2:-2],
                        "marks": [{"type": "strong"}]})
        elif part.startswith("`") and part.endswith("`") and len(part) > 2:
            out.append({"type": "text", "text": part[1:-1],
                        "marks": [{"type": "code"}]})
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            out.append({"type": "text", "text": part[1:-1],
                        "marks": [{"type": "em"}]})
        else:
            out.append({"type": "text", "text": part})
    return out or [{"type": "text", "text": ""}]


def make_cell(text):
    return {"type": "tableCell", "attrs": {"colspan": 1, "rowspan": 1},
            "content": [{"type": "paragraph", "content": inline_nodes(text)}]}


def make_row(cells):
    return {"type": "tableRow", "content": [make_cell(c) for c in cells]}


def set_cell(doc, key, col, text):
    row = ticket_rows(doc).get(key)
    if row is None:
        raise SystemExit(f"{key} is not on this page.")
    row["content"][col] = make_cell(text)


def append_row(doc, cells):
    first_table(doc)["content"].append(make_row(cells))


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("get", help="fetch a page as ADF")
    g.add_argument("page_id")
    g.add_argument("-o", "--out")

    r = sub.add_parser("rows", help="list ticket rows")
    r.add_argument("page_id")

    c = sub.add_parser("cell", help="print one cell")
    c.add_argument("page_id")
    c.add_argument("key")
    c.add_argument("col", type=int)

    p = sub.add_parser("put", help="upload an edited file")
    p.add_argument("page_id")
    p.add_argument("file")
    p.add_argument("-m", "--message", required=True)

    args = parser.parse_args()

    if args.cmd == "get":
        page = fetch(args.page_id)
        path = args.out or f"/tmp/adf-{args.page_id}.json"
        with open(path, "w") as fh:
            json.dump(page, fh)
        doc = doc_of(page)
        print(f"{page['title']} v{page['version']['number']} -> {path}")
        print(f"rows: {len(first_table(doc)['content'])}")

    elif args.cmd == "rows":
        doc = doc_of(fetch(args.page_id))
        keys = list(ticket_rows(doc))
        print(f"{len(keys)} ticket rows")
        print(", ".join(keys))

    elif args.cmd == "cell":
        doc = doc_of(fetch(args.page_id))
        row = ticket_rows(doc).get(args.key)
        if row is None:
            sys.exit(f"{args.key} is not on this page.")
        print(node_text(row["content"][args.col]))

    elif args.cmd == "put":
        with open(args.file) as fh:
            page = json.load(fh)
        result = upload(args.page_id, page, args.message)
        print(f"{result['title']} is now v{result['version']['number']}")


if __name__ == "__main__":
    main()
