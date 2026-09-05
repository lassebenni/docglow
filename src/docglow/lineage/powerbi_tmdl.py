"""Read measures out of a Power BI TMDL semantic model.

Power BI Desktop saves projects as PBIP: a ``<name>.SemanticModel`` (or
``.Dataset``) folder whose ``definition/tables/*.tmdl`` files hold the model in
a tab-indented text format. This module pulls the measures out — name,
description, DAX — so their lineage can be derived without a running Power BI
instance.

TMDL writes a measure's expression in three shapes, all of which appear in real
models::

    measure 'Total' = SUM(fct_orders[amount])          -- inline

    measure 'Ratio' =                                   -- indented block
        DIVIDE([A], [B])

    measure 'Note' = ```                                -- fenced block
        "text"
        ```

An expression ends at the first line indented no deeper than the ``measure``
keyword itself; the property lines that follow it (``formatString``,
``displayFolder``, ``lineageTag``) are more deeply indented and terminate it.
``///`` comment lines directly above a measure are its description.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

_TABLE_RE = re.compile(r"^table\s+(?P<name>'[^']+'|\S+)", re.MULTILINE)
_MEASURE_RE = re.compile(r"^(?P<indent>[\t ]*)measure\s+(?P<name>'[^']*'|[^\s=]+)\s*=(?P<rest>.*)$")
# Property lines that follow a measure and terminate its expression.
_PROPERTIES = (
    "formatString",
    "displayFolder",
    "lineageTag",
    "isHidden",
    "annotation",
    "changedProperty",
    "extendedProperty",
    "relatedColumnDetails",
    "dataCategory",
    "description",
)
_PROPERTY_RE = re.compile(r"^[\t ]*(" + "|".join(_PROPERTIES) + r")\b")
_DESCRIPTION_RE = re.compile(r"^[\t ]*///\s?(?P<text>.*)$")
_FENCE = "```"
_TAB_WIDTH = 4


@dataclass
class TmdlMeasure:
    name: str
    expression: str
    description: str = ""
    display_folder: str = ""
    table: str = ""


@dataclass
class TmdlModel:
    measures: list[TmdlMeasure] = field(default_factory=list)
    tables: set[str] = field(default_factory=set)
    # Tables with no queryable source (calculated tables, inline VALUES lists).
    # They can never map to a dbt model, so callers should not warn about them.
    tables_without_source: set[str] = field(default_factory=set)


def find_model_directory(path: Path) -> Path:
    """Resolve a user-supplied path to the folder containing ``definition/``.

    Accepts the model folder itself, a folder containing one, or the directory
    holding a ``.pbip`` file.
    """
    path = Path(path)
    if (path / "definition" / "tables").is_dir():
        return path
    # A PBIP project holds report folders beside the model, and those carry a
    # `definition/` of their own — only the semantic model has definition/tables.
    candidates = sorted(
        child
        for child in path.iterdir()
        if child.is_dir() and (child / "definition" / "tables").is_dir()
    )
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise FileNotFoundError(
            f"no TMDL semantic model under {path} (expected a folder containing definition/)"
        )
    names = ", ".join(c.name for c in candidates)
    raise ValueError(f"several semantic models under {path} ({names}); point at one of them")


def _unquote(name: str) -> str:
    name = name.strip()
    if len(name) >= 2 and name[0] == "'" and name[-1] == "'":
        return name[1:-1]
    return name


def _indent_width(line: str) -> int:
    """Indent in columns, with tabs expanded — TMDL indents with tabs, and
    comparing a tab count against an expanded width silently mis-nests."""
    expanded = line.expandtabs(_TAB_WIDTH)
    return len(expanded) - len(expanded.lstrip(" "))


def _dedent(body: list[str]) -> str:
    """Strip the common leading indent, measured with tabs expanded."""
    expanded = [line.expandtabs(_TAB_WIDTH) for line in body]
    pad = min(_indent_width(line) for line in expanded if line.strip())
    return "\n".join(line[pad:] if line.strip() else "" for line in expanded)


def _read_block(lines: list[str], start: int, measure_indent: int) -> tuple[str, int]:
    """Collect an indented expression block starting at ``start``.

    Returns the dedented text and the index of the first line after it. A line
    indented no deeper than the measure keyword ends the block, as does a
    property line belonging to the measure.
    """
    body: list[str] = []
    index = start
    while index < len(lines):
        line = lines[index]
        if line.strip():
            if _indent_width(line) <= measure_indent:
                break
            if _PROPERTY_RE.match(line):
                break
            body.append(line)
        else:
            body.append(line)
        index += 1
    while body and not body[-1].strip():
        body.pop()
    if not body:
        return "", index
    return _dedent(body), index


def _read_fenced(lines: list[str], start: int) -> tuple[str, int]:
    """Collect a ```-fenced expression, starting on the line after the opening fence."""
    body: list[str] = []
    index = start
    while index < len(lines) and lines[index].strip() != _FENCE:
        body.append(lines[index])
        index += 1
    index += 1  # step past the closing fence
    while body and not body[0].strip():
        body.pop(0)
    while body and not body[-1].strip():
        body.pop()
    if not body:
        return "", index
    return _dedent(body), index


def parse_tmdl_file(text: str) -> tuple[list[TmdlMeasure], str]:
    """Return the measures defined in one .tmdl file, plus its table name."""
    table_match = _TABLE_RE.search(text)
    table = _unquote(table_match.group("name")) if table_match else ""

    lines = text.splitlines()
    measures: list[TmdlMeasure] = []
    description: list[str] = []
    index = 0

    while index < len(lines):
        line = lines[index]

        note = _DESCRIPTION_RE.match(line)
        if note:
            description.append(note.group("text").rstrip())
            index += 1
            continue

        match = _MEASURE_RE.match(line)
        if not match:
            # Only /// lines immediately above a measure are its description.
            if line.strip():
                description.clear()
            index += 1
            continue

        indent = _indent_width(line)
        rest = match.group("rest").strip()
        if rest == _FENCE:
            expression, index = _read_fenced(lines, index + 1)
        elif rest:
            expression, index = rest, index + 1
        else:
            expression, index = _read_block(lines, index + 1, indent)

        folder = ""
        probe = index
        while probe < len(lines) and _PROPERTY_RE.match(lines[probe]):
            if "displayFolder:" in lines[probe]:
                folder = lines[probe].split("displayFolder:", 1)[1].strip()
            probe += 1

        measures.append(
            TmdlMeasure(
                name=_unquote(match.group("name")),
                expression=expression.strip(),
                description=" ".join(description).strip(),
                display_folder=folder,
                table=table,
            )
        )
        description.clear()

    return measures, table


def read_model(path: Path) -> TmdlModel:
    """Read every measure and table name from a TMDL semantic model folder."""
    root = find_model_directory(Path(path))
    tables_dir = root / "definition" / "tables"
    if not tables_dir.is_dir():
        raise FileNotFoundError(f"no definition/tables under {root}")

    model = TmdlModel()
    for tmdl in sorted(tables_dir.glob("*.tmdl")):
        # Power BI Desktop writes a BOM; utf-8 would leave it on the first line
        # and the `table` header would silently fail to match.
        text = tmdl.read_text(encoding="utf-8-sig")
        measures, table = parse_tmdl_file(text)
        if table:
            model.tables.add(table)
            # Only an `= m` partition queries a warehouse. Anything else — a
            # calculated table, an inline VALUES list, no partition at all — is
            # computed inside the model and has no upstream dbt table.
            if not re.search(r"^\s*partition\s+.*=\s*m\s*$", text, re.MULTILINE):
                model.tables_without_source.add(table)
        model.measures.extend(measures)

    logger.info(
        "TMDL: %d measures across %d tables in %s",
        len(model.measures),
        len(model.tables),
        root.name,
    )
    return model
