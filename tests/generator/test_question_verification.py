"""Tests for docglow.generator.questions verification enrichment."""

from __future__ import annotations

from docglow.artifacts.manifest import Manifest, ManifestNode
from docglow.artifacts.run_results import RunResult, RunResults, RunResultsMetadata
from docglow.generator.questions import attach_question_verification, attach_questions


def _manifest_with_test(test_name: str = "assert_holds") -> Manifest:
    return Manifest.model_validate(
        {
            "metadata": {"dbt_schema_version": "https://schemas.getdbt.com/dbt/manifest/v12.json"},
            "nodes": {
                "test.pkg.assert_holds": {
                    "unique_id": "test.pkg.assert_holds",
                    "name": test_name,
                    "resource_type": "test",
                    "depends_on": {"nodes": ["model.pkg.my_model"]},
                    "compiled_code": "select 1 where false",
                    "raw_code": "select 1 where false",
                }
            },
            "sources": {},
            "macros": {},
            "docs": {},
        }
    )


def _run_results_for_test(unique_id: str, *, status: str = "pass") -> RunResults:
    return RunResults(
        metadata=RunResultsMetadata(generated_at="2026-07-14T18:00:00Z"),
        results=[
            RunResult(
                unique_id=unique_id,
                status=status,
                execution_time=0.142,
                failures=0,
                message=None,
                compiled_code="select * from prod.table where bad",
            )
        ],
    )


def test_attach_verification_pass():
    models = {
        "model.pkg.my_model": {
            "name": "my_model",
            "meta": {
                "docglow": {
                    "questions": [
                        {"question": "Q?", "answer": "A.", "verified_by": "assert_holds"},
                    ]
                }
            },
        }
    }
    attach_questions(models)
    manifest = _manifest_with_test()
    run_results = _run_results_for_test("test.pkg.assert_holds")

    attach_question_verification(models, manifest, run_results)

    verification = models["model.pkg.my_model"]["questions"][0]["verification"]
    assert verification["test_name"] == "assert_holds"
    assert verification["status"] == "pass"
    assert verification["verified_at"] == "2026-07-14T18:00:00Z"
    assert verification["execution_time"] == 0.142
    assert verification["compiled_sql"] == "select * from prod.table where bad"


def test_attach_verification_sql_from_manifest_when_not_in_run_results():
    models = {
        "model.pkg.my_model": {
            "name": "my_model",
            "questions": [
                {"question": "Q?", "answer": "A.", "verified_by": "assert_holds"},
            ],
        }
    }
    manifest = _manifest_with_test()

    attach_question_verification(models, manifest, None)

    verification = models["model.pkg.my_model"]["questions"][0]["verification"]
    assert verification["status"] == "not_run"
    assert verification["compiled_sql"] == "select 1 where false"


def test_attach_verification_not_run_without_run_results():
    models = {
        "model.pkg.my_model": {
            "name": "my_model",
            "questions": [
                {"question": "Q?", "answer": "A.", "verified_by": "assert_holds"},
            ],
        }
    }
    manifest = _manifest_with_test()

    attach_question_verification(models, manifest, None)

    verification = models["model.pkg.my_model"]["questions"][0]["verification"]
    assert verification["status"] == "not_run"
    assert verification["verified_at"] is None


def test_attach_verification_misconfigured_test_name():
    models = {
        "model.pkg.my_model": {
            "name": "my_model",
            "questions": [
                {"question": "Q?", "answer": "A.", "verified_by": "missing_test"},
            ],
        }
    }
    manifest = _manifest_with_test()

    attach_question_verification(models, manifest, None)

    verification = models["model.pkg.my_model"]["questions"][0]["verification"]
    assert verification["status"] == "misconfigured"
    assert "missing_test" in verification["message"]


def test_skips_questions_without_verified_by():
    models = {
        "model.pkg.my_model": {
            "name": "my_model",
            "questions": [{"question": "Q?", "answer": "A."}],
        }
    }
    manifest = _manifest_with_test()

    attach_question_verification(models, manifest, _run_results_for_test("test.pkg.assert_holds"))

    assert "verification" not in models["model.pkg.my_model"]["questions"][0]
