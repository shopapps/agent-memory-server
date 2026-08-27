import pytest

from agent_memory_server.filters import Namespace
from agent_memory_server.models import MemoryRecord, SearchRequest
from agent_memory_server.namespaces import (
    expand_namespace_parents,
    normalize_namespace,
)


def test_normalize_namespace_returns_a_canonical_path():
    assert normalize_namespace(" coding / umony / archive ") == "coding/umony/archive"


@pytest.mark.parametrize(
    "namespace",
    [
        "",
        " ",
        "/coding",
        "coding/",
        "coding//archive",
        ".",
        "..",
        "coding/./archive",
        "coding/../archive",
    ],
)
def test_normalize_namespace_rejects_unsafe_paths(namespace):
    with pytest.raises(ValueError):
        normalize_namespace(namespace)


def test_expand_namespace_parents_returns_only_exact_ancestors():
    assert expand_namespace_parents("coding/umony/archive") == [
        "coding/umony/archive",
        "coding/umony",
        "coding",
    ]


def test_search_request_parent_inheritance_uses_exact_namespace_paths():
    request = SearchRequest(
        namespace=Namespace(eq="coding/umony/archive"),
        inherit_parents=True,
    )

    namespace_filter = request.get_filters()["namespace"]

    assert namespace_filter.eq is None
    assert namespace_filter.any == [
        "coding/umony/archive",
        "coding/umony",
        "coding",
    ]
    assert namespace_filter.startswith is None


def test_search_request_keeps_exact_namespace_search_by_default():
    request = SearchRequest(namespace=Namespace(eq=" coding / umony / archive "))

    namespace_filter = request.get_filters()["namespace"]

    assert namespace_filter.eq == "coding/umony/archive"
    assert namespace_filter.any is None


def test_memory_write_normalizes_and_validates_its_namespace():
    memory = MemoryRecord(id="memory-1", text="fact", namespace=" coding / umony ")

    assert memory.namespace == "coding/umony"

    with pytest.raises(ValueError):
        MemoryRecord(id="memory-2", text="fact", namespace="coding//umony")
