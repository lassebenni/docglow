"""Read column and measure references out of DAX expressions.

Power BI measures are the last hop of a dbt lineage graph: a measure such as
``Total Revenue = SUM(fct_orders[amount])`` reads a column of a table that,
in a dbt-backed model, *is* a dbt model. Parsing the DAX recovers that edge
without anyone hand-maintaining it.

Two things come out of each expression:

* **column references** — ``fct_orders[amount]``, split by role. A column being
  aggregated is a data dependency. A column under ``CALCULATE``/``FILTER``/
  ``ALL``/``TREATAS`` shapes filter context and is not lineage: renaming it
  changes which rows are counted, not where the number comes from.
* **component measures** — ``[Total Revenue]``, i.e. the measure's *direct*
  references. Direct, not transitive:
  :func:`~docglow.lineage.exposure_field_lineage.apply_exposure_field_lineage`
  expands ``components`` itself, and handing it a closure would double-expand.

Dimension tables are treated as filter context whatever encloses them. A
measure reads facts and aggregates and slices them by dimensions, so
``MIN(dim_date[date])`` inside a boundary test is a filter, not a source —
recording it would draw an edge from every date-sliced measure to the date
dimension and drown the real ones.

Requires ``pbi-parsers``, which needs Python 3.11+; install via
``pip install docglow[powerbi]``. Import this module lazily so the rest of
Docglow keeps working on 3.10.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

MIN_PYTHON = (3, 11)

# A column under one of these is being aggregated — a real data dependency.
AGGREGATIONS = frozenset(
    {
        "SUM",
        "SUMX",
        "COUNT",
        "COUNTX",
        "COUNTA",
        "COUNTAX",
        "DISTINCTCOUNT",
        "DISTINCTCOUNTNOBLANK",
        "AVERAGE",
        "AVERAGEX",
        "MIN",
        "MINX",
        "MAX",
        "MAXX",
        "MEDIAN",
        "PRODUCT",
        "PRODUCTX",
        "CONCATENATEX",
        "RANKX",
        "SELECTEDVALUE",
        "FIRSTNONBLANK",
        "LASTNONBLANK",
    }
)
# A column under one of these shapes filter context, not value lineage.
FILTERS = frozenset(
    {
        "CALCULATE",
        "CALCULATETABLE",
        "FILTER",
        "ALL",
        "ALLEXCEPT",
        "ALLSELECTED",
        "ALLNOBLANKROW",
        "REMOVEFILTERS",
        "KEEPFILTERS",
        "VALUES",
        "DISTINCT",
        "TREATAS",
        "INTERSECT",
        "EXCEPT",
        "UNION",
        "USERELATIONSHIP",
        "CROSSFILTER",
        "RELATEDTABLE",
        "ISFILTERED",
        "ISCROSSFILTERED",
        "HASONEVALUE",
        "HASONEFILTER",
        "TOTALYTD",
        "TOTALQTD",
        "TOTALMTD",
        "DATEADD",
        "DATESYTD",
        "SAMEPERIODLASTYEAR",
        "PARALLELPERIOD",
        "DATESBETWEEN",
        "DATESINPERIOD",
    }
)
# Table-name prefixes that never carry mart lineage. `_` covers the disconnected
# helper tables Power BI authors use for field parameters and slicer sources.
DIMENSION_PREFIXES = ("dim_", "_")


class DaxParserUnavailableError(RuntimeError):
    """Raised when pbi-parsers is missing or the interpreter is too old."""


@dataclass(frozen=True)
class ColumnRef:
    table: str
    column: str


@dataclass
class MeasureLineage:
    """What one measure's DAX reads."""

    columns: list[ColumnRef] = field(default_factory=list)
    filter_columns: list[ColumnRef] = field(default_factory=list)
    components: list[str] = field(default_factory=list)
    parse_error: str | None = None


def _load_parser() -> tuple[Any, Any]:
    """Import pbi-parsers, applying the NOT patch once. Raises DaxParserUnavailableError."""
    import sys

    if sys.version_info < MIN_PYTHON:
        raise DaxParserUnavailableError(
            f"DAX parsing needs Python {'.'.join(map(str, MIN_PYTHON))}+ "
            f"(running {sys.version_info.major}.{sys.version_info.minor})"
        )
    try:
        from pbi_parsers.dax import exprs, to_ast
    except ImportError as exc:  # pragma: no cover - depends on install extras
        raise DaxParserUnavailableError(
            "DAX parsing needs pbi-parsers: pip install 'docglow[powerbi]'"
        ) from exc

    from docglow.lineage.powerbi_dax_not import patch_not_operator

    patch_not_operator(exprs)
    return to_ast, exprs


def is_dimension(table: str) -> bool:
    """True when a table is a dimension or helper, so never a lineage source."""
    return table.startswith(DIMENSION_PREFIXES)


def _role(functions: tuple[str, ...]) -> str:
    """Nearest enclosing function decides whether a column is read or filtered."""
    for name in reversed(functions):
        if name in AGGREGATIONS:
            return "data"
        if name in FILTERS:
            return "filter"
    # A column with no enclosing function at all (`Table[Column]` as the whole
    # expression) is a calculated-column-style read, not a filter.
    return "data"


def _walk(
    node: Any, exprs: Any, functions: tuple[str, ...], out: list[tuple[Any, tuple[str, ...]]]
) -> None:
    if isinstance(node, exprs.FunctionExpression):
        functions = (*functions, node.function_name().upper())
    out.append((node, functions))
    for child in node.children():
        if child is not None:
            _walk(child, exprs, functions, out)


def analyze(expression: str) -> MeasureLineage:
    """Parse one DAX expression.

    Parse failures are returned on ``parse_error`` rather than raised: a model
    has hundreds of measures and one unreadable expression must not abort a
    docs build. :class:`DaxParserUnavailableError` *is* raised — that is a setup
    problem, not bad input.
    """
    to_ast, exprs = _load_parser()
    try:
        ast = to_ast(expression)
    except DaxParserUnavailableError:
        raise
    except Exception as exc:
        # pbi-parsers signals unsupported syntax with bare AssertionError as
        # well as ValueError, so the net has to be wide.
        detail = f"{type(exc).__name__}: {exc}".rstrip(": ")
        return MeasureLineage(parse_error=detail)
    if ast is None:
        return MeasureLineage(parse_error="parser returned no AST")

    nodes: list[tuple[Any, tuple[str, ...]]] = []
    _walk(ast, exprs, (), nodes)

    variables = {
        node.var_name.text.strip()
        for node, _ in nodes
        if isinstance(node, exprs.VariableExpression)
    }

    result = MeasureLineage()
    # A column can appear more than once in one expression, in different roles:
    # `SUMX(FILTER(t, t[a] > 0), t[a])` both filters on `a` and sums it. Classify
    # only after seeing every occurrence — deciding on the first one makes the
    # answer depend on walk order, and would drop a real dependency here.
    roles: dict[ColumnRef, set[str]] = {}
    order: list[ColumnRef] = []
    seen_components: set[str] = set()

    for node, functions in nodes:
        if isinstance(node, exprs.ColumnExpression):
            ref = ColumnRef(
                table=node.table.text.strip().strip("'"),
                column=node.column.text.strip().strip("[]"),
            )
            if ref not in roles:
                roles[ref] = set()
                order.append(ref)
            roles[ref].add("filter" if is_dimension(ref.table) else _role(functions))
        elif isinstance(node, exprs.MeasureExpression):
            name = node.name.text.strip().strip("[]")
            # `VAR x = ...` then a bare `[x]` is a variable read, not a measure.
            if name in variables or name in seen_components:
                continue
            seen_components.add(name)
            result.components.append(name)

    for ref in order:
        # Read anywhere means read: a column that is also used as a filter is
        # still a genuine source of the number.
        if "data" in roles[ref]:
            result.columns.append(ref)
        else:
            result.filter_columns.append(ref)

    return result
