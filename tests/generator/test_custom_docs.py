"""Tests for docglow.generator.custom_docs.attach_custom_docs."""

from __future__ import annotations

import logging

from docglow.generator.custom_docs import attach_custom_docs


def _write_html(path, content: str = "<html><body><h1>Guide</h1></body></html>") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_attach_from_meta(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    html = project / "docs" / "my_model.html"
    _write_html(html)
    output = tmp_path / "site"
    output.mkdir()
    models = {
        "model.x.my_model": {
            "name": "my_model",
            "meta": {
                "docglow": {
                    "docs": [{"label": "Guide", "file": "docs/my_model.html", "slug": "guide"}]
                }
            },
        }
    }

    attach_custom_docs(models, project_dir=project, output_dir=output)

    assert models["model.x.my_model"]["custom_docs"] == [
        {"slug": "guide", "label": "Guide", "url": "docs/my_model/guide.html"}
    ]
    assert (output / "docs" / "my_model" / "guide.html").read_text(encoding="utf-8").startswith(
        "<html>"
    )


def test_attach_from_convention_nested(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    docs_dir = project / "docs" / "concepts"
    _write_html(docs_dir / "orders" / "orders.html")
    output = tmp_path / "site"
    output.mkdir()
    models = {"model.x.orders": {"name": "orders", "meta": {}}}

    attach_custom_docs(models, project_dir=project, output_dir=output, docs_dir=docs_dir)

    assert len(models["model.x.orders"]["custom_docs"]) == 1
    assert models["model.x.orders"]["custom_docs"][0]["slug"] == "guide"


def test_meta_takes_precedence_over_convention(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    docs_dir = project / "docs" / "concepts"
    _write_html(docs_dir / "orders" / "orders.html", "<html>convention</html>")
    _write_html(project / "meta.html", "<html>meta</html>")
    output = tmp_path / "site"
    output.mkdir()
    models = {
        "model.x.orders": {
            "name": "orders",
            "meta": {
                "docglow": {
                    "docs": [{"label": "Guide", "file": "meta.html"}]
                }
            },
        }
    }

    attach_custom_docs(models, project_dir=project, output_dir=output, docs_dir=docs_dir)

    docs = models["model.x.orders"]["custom_docs"]
    assert len(docs) == 1
    assert docs[0]["slug"] == "guide"
    assert (output / "docs" / "orders" / "guide.html").read_text(encoding="utf-8") == "<html>meta</html>"


def test_skips_missing_file(tmp_path, caplog):
    project = tmp_path / "project"
    project.mkdir()
    output = tmp_path / "site"
    output.mkdir()
    models = {
        "model.x.m": {
            "name": "m",
            "meta": {"docglow": {"docs": [{"label": "X", "file": "missing.html"}]}},
        }
    }

    with caplog.at_level(logging.WARNING, logger="docglow.generator.custom_docs"):
        attach_custom_docs(models, project_dir=project, output_dir=output)

    assert "custom_docs" not in models["model.x.m"]
    assert any("not found" in r.message for r in caplog.records)


def test_noop_when_no_docs(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    output = tmp_path / "site"
    output.mkdir()
    models = {"model.x.m": {"name": "m", "meta": {}}}

    attach_custom_docs(models, project_dir=project, output_dir=output)

    assert "custom_docs" not in models["model.x.m"]
