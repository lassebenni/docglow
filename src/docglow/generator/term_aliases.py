"""Load BC/Dutch business term aliases for search enrichment.

Parses vt-business-docs-style ``bc_term_aliases.yaml`` and maps Dutch business
terms (omzet, waardebon, retouren, …) onto dbt model/source names so MiniSearch
can match analyst queries.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_BC_SECTIONS = ("bc_tables", "bc_dimensions", "concepts")
_MODEL_PREFIXES = ("stg_", "int_", "fct_", "dim_", "seed_", "snap_")


def _as_str_list(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        return [raw]
    return [str(x) for x in raw if x is not None and str(x).strip()]


def _collect_entry_tokens(eid: str, entry: dict[str, Any]) -> list[str]:
    tokens: list[str] = []
    tokens.extend(_as_str_list(entry.get("dutch_primary")))
    tokens.extend(_as_str_list(entry.get("dutch_aliases")))
    tokens.extend(_as_str_list(entry.get("english_aliases")))
    tokens.extend(_as_str_list(entry.get("abbreviations")))
    tokens.extend(_as_str_list(entry.get("bc_name")))
    tokens.extend(_as_str_list(entry.get("bc_name_alt")))
    if entry.get("english"):
        tokens.append(str(entry["english"]))
    tokens.append(eid)
    tokens.append(eid.replace("_", " "))
    return list(dict.fromkeys(t.strip() for t in tokens if t and str(t).strip()))


def _bare_model_name(name: str) -> str:
    bare = name
    for prefix in _MODEL_PREFIXES:
        if bare.startswith(prefix):
            return bare[len(prefix) :]
    return bare


def _table_suffix(name: str) -> str | None:
    bare = _bare_model_name(name)
    if "__" in bare:
        return bare.rsplit("__", 1)[-1]
    if bare != name:
        return bare
    return None


def _model_matches_table(model_key: str, table_id: str) -> bool:
    """True when *model_key* is the dbt model/source for BC table *table_id*."""
    if model_key == table_id:
        return True
    if model_key.endswith(f"__{table_id}"):
        return True
    suffix = _table_suffix(model_key)
    return suffix == table_id


@dataclass
class TermAliasIndex:
    """Lookup Dutch/English alias tokens by dbt model or source name."""

    by_model: dict[str, set[str]] = field(default_factory=dict)
    by_source: dict[str, set[str]] = field(default_factory=dict)
    by_table_id: dict[str, set[str]] = field(default_factory=dict)

    def aliases_for_name(self, name: str) -> str:
        if not name:
            return ""
        tokens: set[str] = set()
        lowered = name.lower()

        tokens |= self.by_model.get(name, set())
        tokens |= self.by_model.get(lowered, set())
        tokens |= self.by_source.get(name, set())
        tokens |= self.by_source.get(lowered, set())

        suffix = _table_suffix(name)
        if suffix:
            tokens |= self.by_table_id.get(suffix, set())
            tokens |= self.by_source.get(suffix, set())

        bare = _bare_model_name(name)
        if bare != name:
            tokens |= self.by_table_id.get(bare, set())
            tokens |= self.by_source.get(bare, set())

        return " ".join(sorted(tokens))

    def register(self, key: str, tokens: list[str]) -> None:
        if not key or not tokens:
            return
        bucket = self.by_table_id.setdefault(key, set())
        bucket.update(tokens)


def load_term_alias_index(path: Path | None) -> TermAliasIndex | None:
    """Load and index ``bc_term_aliases.yaml``. Returns None when path is unset."""
    if path is None:
        return None
    if not path.exists():
        logger.warning("Term aliases file not found: %s", path)
        return None

    import yaml

    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        logger.warning("Invalid term aliases file (expected mapping): %s", path)
        return None

    index = TermAliasIndex()
    table_tokens: dict[str, set[str]] = {}

    for section in _BC_SECTIONS:
        block = raw.get(section) or {}
        if not isinstance(block, dict):
            continue
        for eid, entry in block.items():
            if not isinstance(entry, dict):
                continue
            tokens = _collect_entry_tokens(str(eid), entry)
            table_tokens[str(eid)] = set(tokens)

            dbt = entry.get("dbt") or {}
            if isinstance(dbt, dict):
                model = str(dbt.get("model") or "").strip()
                source = str(dbt.get("source") or "").strip()
                if model:
                    index.by_model.setdefault(model, set()).update(tokens)
                if source:
                    index.by_source.setdefault(source, set()).update(tokens)

            related = _as_str_list(entry.get("related_tables"))
            for related_id in related:
                table_tokens.setdefault(related_id, set()).update(tokens)

    # Propagate concept aliases to related BC tables.
    concepts = raw.get("concepts") or {}
    if isinstance(concepts, dict):
        for _cid, concept in concepts.items():
            if not isinstance(concept, dict):
                continue
            concept_tokens = _collect_entry_tokens(str(_cid), concept)
            for related_id in _as_str_list(concept.get("related_tables")):
                table_tokens.setdefault(related_id, set()).update(concept_tokens)

    for table_id, token_set in table_tokens.items():
        index.register(table_id, sorted(token_set))
        for model_key, model_tokens in list(index.by_model.items()):
            if _model_matches_table(model_key, table_id):
                model_tokens.update(token_set)
        index.by_source.setdefault(table_id, set()).update(token_set)

    logger.info(
        "Loaded term aliases from %s (%d models, %d sources, %d tables)",
        path,
        len(index.by_model),
        len(index.by_source),
        len(index.by_table_id),
    )
    return index


def enrich_search_entries(
    entries: list[dict[str, Any]],
    alias_index: TermAliasIndex | None,
) -> list[dict[str, Any]]:
    """Add an ``aliases`` field to each search entry when an alias index is available."""
    if alias_index is None:
        return entries

    enriched: list[dict[str, Any]] = []
    for entry in entries:
        name = str(entry.get("name") or "")
        model_name = str(entry.get("model_name") or "")
        lookup_name = model_name if entry.get("resource_type") == "column" else name
        aliases = alias_index.aliases_for_name(lookup_name)
        if aliases:
            enriched.append({**entry, "aliases": aliases})
        else:
            enriched.append(entry)
    return enriched
