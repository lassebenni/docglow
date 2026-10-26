"""Teach pbi-parsers the DAX `NOT` operator.

pbi-parsers (through 0.9.5) has no NOT: it lexes as an ordinary identifier, so
``NOT ISBLANK([A])`` parses as a bare identifier and the operand is left
unconsumed. The parser's own end-of-input assertion catches that, which is the
only reason it surfaces as an error rather than as an expression silently
truncated at the NOT.

`NOT` is common in real models — filter predicates, blank guards — so without
this a large share of measures yields no lineage at all. Remove this module
once a pbi-parsers release ships NOT support.
"""

from __future__ import annotations

from typing import Any

_PATCHED_MARKER = "_docglow_not_expression"


def patch_not_operator(exprs: Any) -> None:
    """Splice a NOT prefix expression into the parser hierarchy. Idempotent."""
    if getattr(exprs, _PATCHED_MARKER, None) is not None:
        return

    from pbi_parsers.dax.exprs._base import Expression
    from pbi_parsers.dax.exprs._utils import lexer_reset
    from pbi_parsers.dax.tokens import TokenType

    class NotExpression(Expression):  # type: ignore[misc]
        """Unary ``NOT <expr>``."""

        def __init__(self, token: Any, operand: Expression) -> None:
            self.token = token
            self.operand = operand

        def children(self) -> list[Expression]:
            return [self.operand]

        def full_text(self) -> str:
            text: str = self.operand.full_text()
            return text

        def position(self) -> tuple[int, int]:
            # Span the NOT keyword too, not just its operand — callers use this
            # to point at source text.
            start: int = self.token.text_slice.start
            return start, self.operand.position()[1]

        def pprint(self) -> str:
            return f"Not ({self.operand.pprint()})"

        @classmethod
        @lexer_reset  # type: ignore[untyped-decorator]
        def match(cls, parser: Any) -> NotExpression | None:
            token = parser.consume()
            if token.tok_type != TokenType.UNQUOTED_IDENTIFIER:
                return None
            if token.text.upper() != "NOT":
                return None
            index = exprs.EXPRESSION_HIERARCHY.index(NotExpression)
            operand = exprs.any_expression_match(parser=parser, skip_first=index + 1)
            if operand is None:
                return None
            return NotExpression(token, operand)

    hierarchy = list(exprs.EXPRESSION_HIERARCHY)
    # After the binary operators, ahead of the prefix-matched expressions —
    # NOT binds looser than arithmetic but must be seen before its operand.
    hierarchy.insert(hierarchy.index(exprs.AddSubUnaryExpression) + 1, NotExpression)
    exprs.EXPRESSION_HIERARCHY = tuple(hierarchy)
    setattr(exprs, _PATCHED_MARKER, NotExpression)
