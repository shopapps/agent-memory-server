"""Encoding helpers for private and shared memory scopes."""

from typing import TypeVar

from agent_memory_server.filters import TagFilter


SHARED_SCOPE = "__shared__"
ScopeFilter = TypeVar("ScopeFilter", bound=TagFilter)


def encode_scope(value: str | None) -> str:
    """Store null scope values as an indexed Redis tag."""
    return value or SHARED_SCOPE


def decode_scope(value: str | None) -> str | None:
    """Hide the internal Redis tag from API and client models."""
    if not value or value == SHARED_SCOPE:
        return None
    return value


def with_shared_scope(filter_value: ScopeFilter | None, filter_type: type[ScopeFilter]):
    """Build an exact private-or-shared filter for one scope dimension."""
    if filter_value is None:
        return filter_type(eq=SHARED_SCOPE)
    if filter_value.eq is not None:
        return filter_type(any=[filter_value.eq, SHARED_SCOPE])
    if filter_value.any is not None:
        return filter_type(any=[*filter_value.any, SHARED_SCOPE])
    raise ValueError("include_shared supports exact or any scope filters only")
