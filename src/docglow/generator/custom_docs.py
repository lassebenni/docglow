"""Attach static HTML concept docs to model payloads.

Two discovery mechanisms (both optional, combinable):

1. **dbt meta** — per-model ``meta.docglow.docs`` entries::

       meta:
         docglow:
           docs:
             - label: Concept
               file: docs/concepts/my_model/my_model.html
               slug: concept  # optional; derived from label when omitted

2. **Convention scan** — when ``docs_dir`` is set, look for::

       <docs_dir>/<model_name>/<model_name>.html
       <docs_dir>/<model_name>.html

At site-generation time each resolved file is copied into the output site at
``docs/<model_name>/<slug>.html`` and a ``custom_docs`` entry (slug, label,
url) is attached to the model.  The frontend renders each entry as a tab
with an ``<iframe>`` so full-document HTML (custom CSS, fonts, SVG) is
preserved without DOMPurify stripping styles.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(label: str) -> str:
    slug = _SLUG_RE.sub("-", label.strip().lower()).strip("-")
    return slug or "doc"


def _valid_slug(slug: str) -> bool:
    return bool(slug) and slug == _slugify(slug.replace("_", "-"))


def _parse_meta_docs(meta: dict[str, Any]) -> list[dict[str, str]]:
    docglow = meta.get("docglow")
    if not isinstance(docglow, dict):
        return []
    raw_docs = docglow.get("docs")
    if not isinstance(raw_docs, list):
        return []
    out: list[dict[str, str]] = []
    for entry in raw_docs:
        if not isinstance(entry, dict):
            continue
        label = entry.get("label")
        file_path = entry.get("file")
        if not isinstance(label, str) or not label.strip():
            logger.warning("meta.docglow.docs entry missing label — skipping")
            continue
        if not isinstance(file_path, str) or not file_path.strip():
            logger.warning("meta.docglow.docs entry %r missing file — skipping", label)
            continue
        slug_raw = entry.get("slug")
        if isinstance(slug_raw, str) and slug_raw.strip():
            slug = slug_raw.strip()
        else:
            slug = _slugify(label)
        if not _valid_slug(slug):
            logger.warning(
                "meta.docglow.docs entry %r has invalid slug %r — skipping",
                label,
                slug,
            )
            continue
        out.append({"label": label.strip(), "file": file_path.strip(), "slug": slug})
    return out


def _convention_candidates(docs_dir: Path, model_name: str) -> list[tuple[str, Path]]:
    nested = docs_dir / model_name / f"{model_name}.html"
    flat = docs_dir / f"{model_name}.html"
    candidates: list[tuple[str, Path]] = []
    if nested.is_file():
        candidates.append(("concept", nested))
    if flat.is_file() and flat != nested:
        candidates.append(("concept", flat))
    return candidates


def _copy_doc(
    *,
    source: Path,
    output_dir: Path,
    model_name: str,
    slug: str,
) -> str:
    """Copy *source* into the site and return the relative URL."""
    dest_dir = output_dir / "docs" / model_name
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{slug}.html"
    dest.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
    return f"docs/{model_name}/{slug}.html"


def attach_custom_docs(
    models: dict[str, dict[str, Any]],
    *,
    project_dir: Path,
    output_dir: Path,
    docs_dir: Path | None = None,
) -> None:
    """Resolve, copy, and attach ``custom_docs`` to each model dict.

    Mutates ``models`` in place.  Fail-soft: missing files are logged and
    skipped; site generation continues.
    """
    project_dir = Path(project_dir)
    output_dir = Path(output_dir)
    resolved_docs_dir = Path(docs_dir) if docs_dir is not None else None
    if resolved_docs_dir is not None and not resolved_docs_dir.is_dir():
        logger.warning(
            "Docs directory %s does not exist — skipping convention scan",
            resolved_docs_dir,
        )
        resolved_docs_dir = None

    attached = 0
    for model in models.values():
        name = model.get("name")
        if not isinstance(name, str) or not name:
            continue

        entries: list[dict[str, str]] = []
        seen_slugs: set[str] = set()

        for spec in _parse_meta_docs(model.get("meta") or {}):
            slug = spec["slug"]
            if slug in seen_slugs:
                logger.warning("Duplicate custom doc slug %r on model %s — skipping", slug, name)
                continue
            source = (project_dir / spec["file"]).resolve()
            if not source.is_file():
                logger.warning(
                    "Custom doc file %s for model %s not found — skipping",
                    spec["file"],
                    name,
                )
                continue
            try:
                url = _copy_doc(source=source, output_dir=output_dir, model_name=name, slug=slug)
            except OSError as e:
                logger.warning("Failed to copy custom doc %s for model %s: %s", source, name, e)
                continue
            entries.append({"slug": slug, "label": spec["label"], "url": url})
            seen_slugs.add(slug)

        if resolved_docs_dir is not None:
            for slug, source in _convention_candidates(resolved_docs_dir, name):
                if slug in seen_slugs:
                    continue
                try:
                    url = _copy_doc(
                        source=source,
                        output_dir=output_dir,
                        model_name=name,
                        slug=slug,
                    )
                except OSError as e:
                    logger.warning(
                        "Failed to copy convention doc %s for model %s: %s",
                        source,
                        name,
                        e,
                    )
                    continue
                entries.append({"slug": slug, "label": "Concept", "url": url})
                seen_slugs.add(slug)

        if entries:
            model["custom_docs"] = entries
            attached += 1

    logger.info("Attached custom_docs to %d model(s)", attached)
