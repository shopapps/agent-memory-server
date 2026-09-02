import pytest
from pydantic import ValidationError

from agent_memory_client.models import ClientMemoryRecord, MemoryRecord


@pytest.mark.parametrize("model", [MemoryRecord, ClientMemoryRecord])
def test_memory_record_normalizes_namespace_path(model):
    memory = model(
        id="memory-1",
        text="private",
        namespace=" coding / umony / archive ",
    )

    assert memory.namespace == "coding/umony/archive"


@pytest.mark.parametrize("model", [MemoryRecord, ClientMemoryRecord])
@pytest.mark.parametrize(
    "namespace",
    ["/coding", "coding/", "coding//archive", "coding/./archive", "coding/../archive"],
)
def test_memory_record_rejects_unsafe_namespace_paths(model, namespace):
    with pytest.raises(ValidationError):
        model(id="memory-1", text="private", namespace=namespace)


@pytest.mark.parametrize("model", [MemoryRecord, ClientMemoryRecord])
@pytest.mark.parametrize(
    "field",
    ["namespace", "project_id", "user_id", "agent_id", "session_id"],
)
def test_memory_record_rejects_commas_in_scope_values(model, field):
    with pytest.raises(ValidationError, match="must not contain commas"):
        model(
            id="memory-1",
            text="private",
            **{field: "scope-a,scope-b"},
        )


@pytest.mark.parametrize("model", [MemoryRecord, ClientMemoryRecord])
@pytest.mark.parametrize(
    "field",
    ["project_id", "user_id", "agent_id", "session_id"],
)
def test_memory_record_rejects_internal_shared_scope_value(model, field):
    with pytest.raises(ValidationError, match="reserved for internal storage"):
        model(
            id="memory-1",
            text="private",
            **{field: "__shared__"},
        )
