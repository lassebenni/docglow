"""Tests for docglow.generator.questions.attach_questions."""

from __future__ import annotations

import logging

from docglow.generator.questions import attach_questions


def test_attach_from_meta():
    models = {
        "model.x.my_model": {
            "name": "my_model",
            "meta": {
                "docglow": {
                    "questions": [
                        {
                            "question": "How does SKU-level data roll up to series level?",
                            "answer": "Summed via `dim_sku.item_series_code`.",
                            "proof": "workbook#cte-sku_bridge",
                        },
                        {
                            "question": "Which price does the app show?",
                            "answer": "The effective sales price.",
                        },
                    ]
                }
            },
        }
    }

    attach_questions(models)

    assert models["model.x.my_model"]["questions"] == [
        {
            "question": "How does SKU-level data roll up to series level?",
            "answer": "Summed via `dim_sku.item_series_code`.",
            "proof": "workbook#cte-sku_bridge",
        },
        {
            "question": "Which price does the app show?",
            "answer": "The effective sales price.",
        },
    ]


def test_strips_whitespace_and_omits_blank_proof():
    models = {
        "model.x.m": {
            "name": "m",
            "meta": {
                "docglow": {
                    "questions": [
                        {"question": "  Q?  ", "answer": "  A.  ", "proof": "   "},
                    ]
                }
            },
        }
    }

    attach_questions(models)

    assert models["model.x.m"]["questions"] == [{"question": "Q?", "answer": "A."}]


def test_skips_malformed_entries(caplog):
    models = {
        "model.x.m": {
            "name": "m",
            "meta": {
                "docglow": {
                    "questions": [
                        "not a mapping",
                        {"answer": "no question"},
                        {"question": "no answer"},
                        {"question": "", "answer": "blank question"},
                        {"question": "Valid?", "answer": "Yes."},
                    ]
                }
            },
        }
    }

    with caplog.at_level(logging.WARNING, logger="docglow.generator.questions"):
        attach_questions(models)

    assert models["model.x.m"]["questions"] == [{"question": "Valid?", "answer": "Yes."}]
    assert len([r for r in caplog.records if "skipping" in r.message]) == 4


def test_noop_when_no_questions():
    models = {
        "model.x.m": {"name": "m", "meta": {}},
        "model.x.n": {"name": "n", "meta": {"docglow": {"questions": "not a list"}}},
    }

    attach_questions(models)

    assert "questions" not in models["model.x.m"]
    assert "questions" not in models["model.x.n"]
