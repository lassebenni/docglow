"""Tests for dbt macro expansion."""

from __future__ import annotations

from docglow.lineage.macro_expander import expand_macros


class TestSurrogateKey:
    def test_basic(self) -> None:
        sql = "SELECT {{ dbt_utils.surrogate_key(['col_a', 'col_b']) }} AS sk FROM t"
        result = expand_macros(sql)
        assert "CONCAT(col_a, col_b)" in result
        assert "{{" not in result

    def test_single_column(self) -> None:
        sql = """{{ dbt_utils.surrogate_key(["order_id"]) }}"""
        result = expand_macros(sql)
        assert "CONCAT(order_id)" in result

    def test_empty_list(self) -> None:
        sql = "{{ dbt_utils.surrogate_key([]) }}"
        result = expand_macros(sql)
        assert result == "NULL"


class TestStar:
    def test_with_ref(self) -> None:
        sql = "SELECT {{ dbt_utils.star(ref('stg_orders')) }} FROM stg_orders"
        result = expand_macros(sql)
        assert "*" in result
        assert "dbt_utils" not in result

    def test_with_except(self) -> None:
        sql = "SELECT {{ dbt_utils.star(ref('model'), except=['id']) }} FROM model"
        result = expand_macros(sql)
        assert "*" in result

    def test_with_source(self) -> None:
        sql = "SELECT {{ dbt_utils.star(source('raw', 'orders')) }} FROM raw.orders"
        result = expand_macros(sql)
        assert "*" in result


class TestDateTrunc:
    def test_dbt_date_trunc(self) -> None:
        result = expand_macros("{{ dbt.date_trunc('day', 'created_at') }}")
        assert result == "DATE_TRUNC('day', created_at)"

    def test_dbt_utils_date_trunc(self) -> None:
        result = expand_macros("{{ dbt_utils.date_trunc('month', 'order_date') }}")
        assert result == "DATE_TRUNC('month', order_date)"

    def test_unquoted_column(self) -> None:
        result = expand_macros("{{ dbt.date_trunc('week', updated_at) }}")
        assert result == "DATE_TRUNC('week', updated_at)"


class TestSafeCast:
    def test_basic(self) -> None:
        result = expand_macros("{{ dbt.safe_cast('amount', 'integer') }}")
        assert result == "CAST(amount AS integer)"

    def test_with_api_column(self) -> None:
        result = expand_macros(
            "{{ dbt.safe_cast('revenue', api.Column.translate_type('integer')) }}"
        )
        assert result == "CAST(revenue AS integer)"


class TestCurrentTimestamp:
    def test_dbt(self) -> None:
        result = expand_macros("{{ dbt.current_timestamp() }}")
        assert result == "CURRENT_TIMESTAMP"

    def test_dbt_utils(self) -> None:
        result = expand_macros("{{ dbt_utils.current_timestamp() }}")
        assert result == "CURRENT_TIMESTAMP"


class TestDatediff:
    def test_basic(self) -> None:
        result = expand_macros("{{ dbt.datediff('start_date', 'end_date', 'day') }}")
        assert result == "DATEDIFF('day', start_date, end_date)"


class TestDateadd:
    def test_basic(self) -> None:
        result = expand_macros("{{ dbt.dateadd('day', -7, 'created_at') }}")
        assert result == "DATEADD('day', -7, created_at)"


class TestTypeHelpers:
    def test_type_string(self) -> None:
        assert expand_macros("{{ type_string() }}") == "VARCHAR"
        assert expand_macros("{{ dbt.type_string() }}") == "VARCHAR"

    def test_type_int(self) -> None:
        assert expand_macros("{{ type_int() }}") == "INTEGER"

    def test_type_timestamp(self) -> None:
        assert expand_macros("{{ type_timestamp() }}") == "TIMESTAMP"

    def test_type_float(self) -> None:
        assert expand_macros("{{ type_float() }}") == "FLOAT"

    def test_type_numeric(self) -> None:
        assert expand_macros("{{ type_numeric() }}") == "NUMERIC"

    def test_type_boolean(self) -> None:
        assert expand_macros("{{ dbt.type_boolean() }}") == "BOOLEAN"


class TestUnrecognizedMacros:
    def test_unknown_macro_with_column_arg_preserved(self) -> None:
        """Column-like args are kept so lineage can continue past project macros."""
        sql = "SELECT {{ my_custom_macro('x') }} FROM t"
        result = expand_macros(sql)
        assert result == "SELECT x FROM t"

    def test_unknown_macro_without_column_args_unchanged(self) -> None:
        """Macros with no column-like args are left for the NULL fallback."""
        sql = "SELECT {{ unknown_func() }}, {{ other(1, true) }} FROM t"
        result = expand_macros(sql)
        assert "{{ unknown_func() }}" in result
        assert "{{ other(1, true) }}" in result

    def test_partial_expansion(self) -> None:
        """Known macros expand; arg-less unknowns stay."""
        sql = "SELECT {{ dbt.date_trunc('day', 'ts') }}, {{ unknown_func() }} FROM t"
        result = expand_macros(sql)
        assert "DATE_TRUNC('day', ts)" in result
        assert "{{ unknown_func() }}" in result


class TestStripJinjaIntegration:
    """Test that expand_macros works correctly in the strip_jinja pipeline."""

    def test_end_to_end(self) -> None:
        from docglow.lineage.analyzer import strip_jinja

        raw_sql = (
            "{{ config(materialized='table') }}\n"
            "SELECT\n"
            "  {{ dbt_utils.surrogate_key(['order_id', 'customer_id']) }} AS sk,\n"
            "  {{ dbt.date_trunc('day', 'created_at') }} AS created_day,\n"
            "  {{ my_unknown_macro() }} AS unknown_col\n"
            "FROM {{ ref('stg_orders') }}"
        )
        result = strip_jinja(raw_sql)

        assert "CONCAT(order_id, customer_id)" in result
        assert "DATE_TRUNC('day', created_at)" in result
        assert "NULL" in result  # unknown macro
        assert "stg_orders" in result  # ref resolved
        assert "config" not in result  # config removed

    def test_if_else_keeps_else_branch_only(self) -> None:
        """Adapter if/else must not leave both SQL arms (invalid parse)."""
        from docglow.lineage.analyzer import strip_jinja

        raw_sql = """
        SELECT
            {% if target.type == "duckdb" %}
                cast(strftime(cast(d as date), '%Y-%m-%d') as timestamp)
            {% else %}
                cast(d as timestamp) + cast(t as time)
            {% endif %} as transaction_timestamp
        FROM {{ source('xprt', 'pos_trans_header') }}
        """
        result = strip_jinja(raw_sql)
        compact = " ".join(result.lower().split())
        assert "strftime" not in compact
        assert "cast(d as timestamp) + cast(t as time)" in compact
        assert "xprt.pos_trans_header" in result
        assert "{%" not in result

    def test_var_default_kept_in_where_filter(self) -> None:
        """{{ var('x', 'default') }} must not become CAST('NULL' AS DATE)."""
        from docglow.lineage.analyzer import strip_jinja

        raw_sql = """
        select *
        from {{ ref('fct_sales_txn_line') }}
        where
            transaction_source = 'POS'
            and posting_date
            >= '{{ var("historical_cutoff_date", "2023-01-01") }}'::date
        """
        result = strip_jinja(raw_sql)
        compact = " ".join(result.split())
        assert "fct_sales_txn_line" in result
        assert "'2023-01-01'::date" in compact or '"2023-01-01"::date' in compact
        assert "CAST('NULL'" not in compact.upper().replace(" ", "")
        assert "{{" not in result

    def test_union_relations_becomes_union_all(self) -> None:
        from docglow.lineage.analyzer import strip_jinja

        raw_sql = """
        {{ config(materialized="view") }}
        {{
            dbt_utils.union_relations(
                relations=[
                    ref("int_sales_txn_line__pos"),
                    ref("int_sales_txn_line__postings"),
                ],
            )
        }}
        """
        result = strip_jinja(raw_sql)
        compact = " ".join(result.split())
        assert "SELECT * FROM int_sales_txn_line__pos" in compact
        assert "UNION ALL" in compact
        assert "SELECT * FROM int_sales_txn_line__postings" in compact
        assert "NULL" not in compact.replace("UNION ALL", "")
        assert "{{" not in result

    def test_column_arg_macro_keeps_lineage_ref(self) -> None:
        """{{ is_discount('table.col') }} must not become NULL."""
        from docglow.lineage.analyzer import strip_jinja

        raw_sql = """
        select
            {{ is_discount("pos_trans_line.line_type") }} as is_discount,
            {{ is_discount("bc_line_type", discount_types=(9,)) }} as is_discount_postings
        from {{ ref("stg_xprt__pos_trans_line") }} pos_trans_line
        """
        result = strip_jinja(raw_sql)
        assert "pos_trans_line.line_type" in result
        assert "bc_line_type" in result
        assert "NULL as is_discount" not in result
        assert "{{" not in result

    def test_batch_set_literals_and_unresolved_idents(self) -> None:
        """Microbatch {% set %} windows: literals resolve; unresolved idents stay named."""
        from docglow.lineage.analyzer import strip_jinja

        raw_sql = """
        {%- set _batch = model.get("batch") -%}
        {%- if _batch and _batch.get("event_time_start") -%}
            {%- set _batch_start = (_batch.get("event_time_start") | string)[:10] -%}
            {%- set _batch_end = (_batch.get("event_time_end") | string)[:10] -%}
        {%- else -%}
            {%- set _batch_start = sales_txn_line_enriched_microbatch_begin() -%}
            {%- set _batch_end = "9999-12-31" -%}
        {%- endif -%}
        select *
        from {{ ref("int_sales_txn_line__union") }}
        where
            posting_date >= '{{ _batch_start }}'::date
            and posting_date < '{{ _batch_end }}'::date
        """
        result = strip_jinja(raw_sql)
        compact = " ".join(result.split())
        assert "int_sales_txn_line__union" in result
        assert "'9999-12-31'::date" in compact
        assert "'_batch_start'::date" in compact
        assert "'NULL'" not in compact
        assert "{{" not in result
        assert "{%" not in result
