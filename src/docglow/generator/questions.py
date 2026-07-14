"""Attach business Q&A entries to model payloads.

Per-model ``meta.docglow.questions`` entries::

    meta:
      docglow:
        questions:
          - question: "Hoe komt SKU-niveau verkoop op serie-niveau?"
            answer: "Optellen via `dim_sku.item_series_code`."
            proof: "workbook#cte-sku_bridge"  # optional; "<custom-doc slug>#<anchor>" or "self#<anchor>"

Pure data — no files to copy.  Each valid entry is attached to the model as
``model["questions"] = [{"question", "answer", "proof"?}]`` and the frontend
renders them as a native Questions tab.  The optional ``proof`` reference
points at a ``custom_docs`` tab (by slug) plus an in-document anchor.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def _parse_meta_questions(meta: dict[str, Any], model_name: str) -> list[dict[str, str]]:
    docglow = meta.get("docglow")
    if not isinstance(docglow, dict):
        return []
    raw = docglow.get("questions")
    if not isinstance(raw, list):
        return []
    out: list[dict[str, str]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            logger.warning(
                "meta.docglow.questions entry on model %s is not a mapping — skipping",
                model_name,
            )
            continue
        question = entry.get("question")
        answer = entry.get("answer")
        if not isinstance(question, str) or not question.strip():
            logger.warning(
                "meta.docglow.questions entry on model %s missing question — skipping",
                model_name,
            )
            continue
        if not isinstance(answer, str) or not answer.strip():
            logger.warning(
                "meta.docglow.questions entry %r on model %s missing answer — skipping",
                question.strip()[:60],
                model_name,
            )
            continue
        parsed: dict[str, str] = {"question": question.strip(), "answer": answer.strip()}
        proof = entry.get("proof")
        if isinstance(proof, str) and proof.strip():
            parsed["proof"] = proof.strip()
        out.append(parsed)
    return out


def attach_questions(models: dict[str, dict[str, Any]]) -> None:
    """Parse ``meta.docglow.questions`` and attach ``questions`` to each model dict.

    Mutates ``models`` in place.  Fail-soft: malformed entries are logged and
    skipped; site generation continues.
    """
    attached = 0
    for model in models.values():
        name = model.get("name")
        if not isinstance(name, str) or not name:
            continue
        entries = _parse_meta_questions(model.get("meta") or {}, name)
        if entries:
            model["questions"] = entries
            attached += 1
    logger.info("Attached questions to %d model(s)", attached)
