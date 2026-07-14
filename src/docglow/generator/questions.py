"""Attach business Q&A entries to model payloads.

Per-model ``meta.docglow.questions`` entries::

    meta:
      docglow:
        questions:
          - question: "Hoe komt SKU-niveau verkoop op serie-niveau?"
            answer: "Optellen via `dim_sku.item_series_code`."
            proof: "workbook#cte-sku_bridge"  # optional; "<custom-doc slug>#<anchor>" or "self#<anchor>"
            verified_by: "assert_sku_bridge"  # optional; dbt test name proving the answer

Pure data — no files to copy.  Each valid entry is attached to the model as
``model["questions"] = [{"question", "answer", "proof"?}]`` and the frontend
renders them as a native Questions tab.  The optional ``proof`` reference
points at a ``custom_docs`` tab (by slug) plus an in-document anchor.

When ``verified_by`` is set, ``attach_question_verification`` enriches each
question with a ``verification`` block resolved from manifest + run_results.
"""

from __future__ import annotations

import logging
from typing import Any

from docglow.artifacts.manifest import Manifest
from docglow.artifacts.run_results import RunResults
from docglow.generator.transforms.lookups import build_run_results_map, normalize_test_status

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
        verified_by = entry.get("verified_by")
        if isinstance(verified_by, str) and verified_by.strip():
            parsed["verified_by"] = verified_by.strip()
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


def _tests_by_name(manifest: Manifest) -> dict[str, Any]:
    return {
        node.name: node
        for node in manifest.nodes.values()
        if node.resource_type == "test"
    }


def _test_type(test_node: Any) -> str:
    if test_node.test_metadata:
        return test_node.test_metadata.name
    if test_node.resource_type == "unit_test":
        return "unit_test"
    return ""


def _test_sql(test_node: Any, run_result: Any | None) -> tuple[str | None, str | None]:
    """Return (compiled_sql, raw_sql) for a dbt test node.

    Prefer run_results compiled SQL (post-run), then manifest compiled_code,
    then raw Jinja source as a last resort for the expandable panel."""
    compiled = None
    raw = (getattr(test_node, "raw_code", None) or "").strip() or None
    if run_result and run_result.compiled_code:
        compiled = run_result.compiled_code.strip() or None
    elif test_node.compiled_code:
        compiled = test_node.compiled_code.strip() or None
    return compiled, raw


def _sql_fields(test_node: Any | None, run_result: Any | None) -> dict[str, str | None]:
    if test_node is None:
        return {"compiled_sql": None, "raw_sql": None}
    compiled, raw = _test_sql(test_node, run_result)
    return {"compiled_sql": compiled, "raw_sql": raw}


def _verification_block(
    *,
    test_name: str,
    test_node: Any | None,
    run_results_by_id: dict[str, Any],
    verified_at: str | None,
) -> dict[str, Any]:
    if test_node is None:
        return {
            "test_name": test_name,
            "test_unique_id": "",
            "test_type": "",
            "status": "misconfigured",
            "failures": 0,
            "message": f"dbt test '{test_name}' not found in manifest",
            "execution_time": 0.0,
            "verified_at": verified_at,
            "compiled_sql": None,
            "raw_sql": None,
        }

    sql = _sql_fields(test_node, run_results_by_id.get(test_node.unique_id))
    run_result = run_results_by_id.get(test_node.unique_id)
    if run_result is None:
        return {
            "test_name": test_name,
            "test_unique_id": test_node.unique_id,
            "test_type": _test_type(test_node),
            "status": "not_run",
            "failures": 0,
            "message": "Test was not in the run that produced run_results.json",
            "execution_time": 0.0,
            "verified_at": verified_at,
            **sql,
        }

    return {
        "test_name": test_name,
        "test_unique_id": test_node.unique_id,
        "test_type": _test_type(test_node),
        "status": normalize_test_status(run_result.status),
        "failures": run_result.failures or 0,
        "message": run_result.message,
        "execution_time": run_result.execution_time,
        "verified_at": verified_at,
        **sql,
    }


def attach_question_verification(
    models: dict[str, dict[str, Any]],
    manifest: Manifest,
    run_results: RunResults | None,
) -> None:
    """Enrich ``questions[].verification`` from manifest test nodes + run_results.

    Mutates ``models`` in place.  Questions without ``verified_by`` are unchanged.
    """
    tests_by_name = _tests_by_name(manifest)
    run_results_by_id = build_run_results_map(run_results)
    verified_at = (
        run_results.metadata.generated_at.strip()
        if run_results and run_results.metadata.generated_at
        else None
    )
    enriched = 0

    for model in models.values():
        questions = model.get("questions")
        if not isinstance(questions, list):
            continue
        for question in questions:
            if not isinstance(question, dict):
                continue
            test_name = question.get("verified_by")
            if not isinstance(test_name, str) or not test_name.strip():
                continue
            test_name = test_name.strip()
            test_node = tests_by_name.get(test_name)
            if test_node is None:
                logger.warning(
                    "question on model %s references verified_by '%s' — no such test in manifest",
                    model.get("name"),
                    test_name,
                )
            question["verification"] = _verification_block(
                test_name=test_name,
                test_node=test_node,
                run_results_by_id=run_results_by_id,
                verified_at=verified_at,
            )
            enriched += 1

    logger.info("Attached verification to %d question(s)", enriched)
