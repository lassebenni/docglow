"""Tests for docglow.generator.seed_data.attach_seed_data."""

from __future__ import annotations

import json
import logging
from pathlib import Path

from docglow.generator.seed_data import attach_seed_data
from docglow.generator.site import generate_site


def _seed_dict(name: str, path: str, **extra: object) -> dict:
    return {
        "name": name,
        "schema": "dbt_prod_seeds",
        "path": path,
        **extra,
    }


def test_attach_reads_seed_csv(tmp_path: Path) -> None:
    seeds_dir = tmp_path / "seeds"
    seeds_dir.mkdir()
    csv_path = seeds_dir / "dim_web_shop.csv"
    csv_path.write_text(
        "domain,web_shop_code,web_shop_name\n"
        "example.com,WS01,Example Shop\n"
        "other.com,WS02,Other Shop\n",
        encoding="utf-8",
    )

    seeds = {
        "seed.proj.dim_web_shop": _seed_dict("dim_web_shop", "seeds/dim_web_shop.csv"),
    }
    attach_seed_data(seeds, tmp_path)

    payload = seeds["seed.proj.dim_web_shop"]["sample_data"]
    assert payload["table"] == "dim_web_shop"
    assert payload["schema"] == "dbt_prod_seeds"
    assert payload["columns"] == ["domain", "web_shop_code", "web_shop_name"]
    assert payload["rows"] == [
        ["example.com", "WS01", "Example Shop"],
        ["other.com", "WS02", "Other Shop"],
    ]
    assert payload["row_count"] == 2


def test_attach_preserves_leading_zeros(tmp_path: Path) -> None:
    seeds_dir = tmp_path / "seeds"
    seeds_dir.mkdir()
    (seeds_dir / "codes.csv").write_text("code\n001\n", encoding="utf-8")

    seeds = {"seed.proj.codes": _seed_dict("codes", "seeds/codes.csv")}
    attach_seed_data(seeds, tmp_path)

    assert seeds["seed.proj.codes"]["sample_data"]["rows"] == [["001"]]


def test_attach_withholds_pii_columns(tmp_path: Path) -> None:
    seeds_dir = tmp_path / "seeds"
    seeds_dir.mkdir()
    (seeds_dir / "users.csv").write_text(
        "id,email\n1,a@b.nl\n",
        encoding="utf-8",
    )

    seeds = {
        "seed.proj.users": _seed_dict(
            "users",
            "seeds/users.csv",
            columns=[
                {"name": "id", "meta": {}},
                {"name": "email", "meta": {"pii": True}},
            ],
        ),
    }
    attach_seed_data(seeds, tmp_path)

    payload = seeds["seed.proj.users"]["sample_data"]
    assert payload["columns"] == ["id"]
    assert payload["rows"] == [["1"]]
    assert payload["all_columns"] == ["id", "email"]
    assert payload["excluded_columns"] == {"pii_meta": ["email"], "name_flagged": []}


def test_attach_withholds_name_flagged_columns(tmp_path: Path) -> None:
    seeds_dir = tmp_path / "seeds"
    seeds_dir.mkdir()
    (seeds_dir / "contacts.csv").write_text(
        "id,customer_email\n1,a@b.nl\n",
        encoding="utf-8",
    )

    seeds = {
        "seed.proj.contacts": _seed_dict(
            "contacts",
            "seeds/contacts.csv",
            columns=[
                {"name": "id", "meta": {}},
                {"name": "customer_email", "meta": {}},
            ],
        ),
    }
    attach_seed_data(seeds, tmp_path)

    payload = seeds["seed.proj.contacts"]["sample_data"]
    assert payload["columns"] == ["id"]
    assert payload["rows"] == [["1"]]
    assert payload["excluded_columns"] == {"pii_meta": [], "name_flagged": ["customer_email"]}


def test_attach_respects_csv_delimiter(tmp_path: Path) -> None:
    seeds_dir = tmp_path / "seeds"
    seeds_dir.mkdir()
    (seeds_dir / "eu.csv").write_text(
        "code;label\nA01;Alpha\n",
        encoding="utf-8",
    )

    seeds = {
        "seed.proj.eu": _seed_dict(
            "eu",
            "seeds/eu.csv",
            csv_delimiter=";",
        ),
    }
    attach_seed_data(seeds, tmp_path)

    payload = seeds["seed.proj.eu"]["sample_data"]
    assert payload["columns"] == ["code", "label"]
    assert payload["rows"] == [["A01", "Alpha"]]


def test_attach_parses_quoted_multiline_cells(tmp_path: Path) -> None:
    seeds_dir = tmp_path / "seeds"
    seeds_dir.mkdir()
    (seeds_dir / "notes.csv").write_text(
        'id,desc\nVT01,"Line one\nLine two"\n',
        encoding="utf-8",
    )

    seeds = {"seed.proj.notes": _seed_dict("notes", "seeds/notes.csv")}
    attach_seed_data(seeds, tmp_path)

    assert seeds["seed.proj.notes"]["sample_data"]["rows"] == [["VT01", "Line one\nLine two"]]


def test_attach_skips_package_seeds(tmp_path: Path) -> None:
    seeds_dir = tmp_path / "seeds"
    seeds_dir.mkdir()
    (seeds_dir / "ref.csv").write_text("id\n1\n", encoding="utf-8")

    seeds = {"seed.pkg.ref": _seed_dict("ref", "seeds/ref.csv", is_package=True)}
    attach_seed_data(seeds, tmp_path)
    assert "sample_data" not in seeds["seed.pkg.ref"]


def test_attach_skips_missing_csv(tmp_path: Path, caplog) -> None:
    seeds = {"seed.proj.missing": _seed_dict("missing", "seeds/missing.csv")}

    with caplog.at_level(logging.WARNING, logger="docglow.generator.seed_data"):
        attach_seed_data(seeds, tmp_path)

    assert "sample_data" not in seeds["seed.proj.missing"]
    assert any("Seed CSV not found" in r.message for r in caplog.records)


def test_attach_skips_path_outside_project(tmp_path: Path, caplog) -> None:
    outside = tmp_path / "outside.csv"
    outside.write_text("id\n1\n", encoding="utf-8")
    seeds = {"seed.proj.bad": _seed_dict("bad", "../outside.csv")}

    with caplog.at_level(logging.WARNING, logger="docglow.generator.seed_data"):
        attach_seed_data(seeds, tmp_path)

    assert "sample_data" not in seeds["seed.proj.bad"]
    assert any("escapes project directory" in r.message for r in caplog.records)


def test_attach_respects_row_limit(tmp_path: Path) -> None:
    seeds_dir = tmp_path / "seeds"
    seeds_dir.mkdir()
    lines = ["id"] + [str(i) for i in range(10)]
    (seeds_dir / "big.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")

    seeds = {"seed.proj.big": _seed_dict("big", "seeds/big.csv")}
    attach_seed_data(seeds, tmp_path, row_limit=3)

    payload = seeds["seed.proj.big"]["sample_data"]
    assert len(payload["rows"]) == 3
    assert payload["row_count"] == 10
    assert payload["limit"] == 3


def test_attach_noop_when_disabled(tmp_path: Path) -> None:
    seeds_dir = tmp_path / "seeds"
    seeds_dir.mkdir()
    (seeds_dir / "x.csv").write_text("id\n1\n", encoding="utf-8")
    seeds = {"seed.proj.x": _seed_dict("x", "seeds/x.csv")}

    attach_seed_data(seeds, tmp_path, enabled=False)
    assert "sample_data" not in seeds["seed.proj.x"]


def test_attach_noop_on_none_project_dir() -> None:
    seeds = {"seed.proj.x": _seed_dict("x", "seeds/x.csv")}
    attach_seed_data(seeds, None)
    assert "sample_data" not in seeds["seed.proj.x"]


def test_generate_site_attaches_seed_sample_data(tmp_path: Path) -> None:
    project = tmp_path / "project"
    target = project / "target"
    target.mkdir(parents=True)
    for name in ("manifest.json", "catalog.json", "run_results.json"):
        src = Path(__file__).resolve().parents[1] / "fixtures" / name
        (target / name).write_text(src.read_text(encoding="utf-8"), encoding="utf-8")

    manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
    seed_id = "seed.jaffle_shop.dim_web_shop"
    manifest["nodes"][seed_id] = {
        "database": "jaffle_shop",
        "schema": "raw",
        "name": "dim_web_shop",
        "resource_type": "seed",
        "package_name": "jaffle_shop",
        "path": "seeds/dim_web_shop.csv",
        "original_file_path": "seeds/dim_web_shop.csv",
        "unique_id": seed_id,
        "description": "",
        "columns": {
            "domain": {"name": "domain", "description": ""},
            "web_shop_code": {"name": "web_shop_code", "description": ""},
        },
        "meta": {},
        "tags": [],
        "config": {"materialized": "seed", "enabled": True},
        "depends_on": {"macros": [], "nodes": []},
        "refs": [],
        "sources": [],
        "raw_code": "",
        "compiled_code": None,
    }
    (target / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    seeds_dir = project / "seeds"
    seeds_dir.mkdir()
    (seeds_dir / "dim_web_shop.csv").write_text(
        "domain,web_shop_code\nexample.com,WS01\n",
        encoding="utf-8",
    )

    output = tmp_path / "out"
    generate_site(project, output_dir=output)

    data = json.loads((output / "docglow-data.json").read_text(encoding="utf-8"))
    assert seed_id in data["seeds"]
    assert data["seeds"][seed_id]["sample_data"]["rows"] == [["example.com", "WS01"]]
