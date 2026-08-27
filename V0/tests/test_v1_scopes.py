from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

from agent_memory_server.filters import AgentId, ProjectId, SessionId, UserId
from agent_memory_server.long_term_memory import (
    compact_long_term_memories,
    deduplicate_by_semantic_search,
    search_long_term_memories,
)
from agent_memory_server.memory_vector_db_factory import _build_redis_schema
from agent_memory_server.models import (
    EditMemoryRecordRequest,
    MemoryRecord,
    MemoryRecordResults,
    SearchRequest,
    UpdateWorkingMemory,
    WorkingMemory,
)
from agent_memory_server.scopes import SHARED_SCOPE
from agent_memory_server.utils.recency import generate_memory_hash


def test_memory_record_scope_fields_survive_json_round_trip():
    memory = MemoryRecord(
        id="memory-1",
        text="A project fact",
        namespace="coding/umony",
        project_id="umony/archive-content-relay",
        user_id="paul",
        agent_id="codex",
        session_id="session-1",
    )

    restored = MemoryRecord.model_validate_json(memory.model_dump_json())

    assert restored.project_id == "umony/archive-content-relay"
    assert restored.agent_id == "codex"


def test_search_request_exposes_exact_project_and_agent_scope_filters():
    request = SearchRequest(
        project_id=ProjectId(eq="umony/archive-content-relay"),
        agent_id=AgentId(eq="codex"),
    )

    filters = request.get_filters()

    assert filters["project_id"].eq == "umony/archive-content-relay"
    assert filters["agent_id"].eq == "codex"


def test_search_request_treats_omitted_scopes_as_shared_only():
    filters = SearchRequest().get_filters()

    assert filters["project_id"].eq == SHARED_SCOPE
    assert filters["user_id"].eq == SHARED_SCOPE
    assert filters["agent_id"].eq == SHARED_SCOPE
    assert filters["session_id"].eq == SHARED_SCOPE


def test_redis_schema_indexes_project_and_agent_as_tags():
    fields = {field["name"]: field for field in _build_redis_schema()["fields"]}

    assert fields["project_id"]["type"] == "tag"
    assert fields["agent_id"]["type"] == "tag"


def test_include_shared_adds_only_exact_and_null_scope_values():
    request = SearchRequest(
        project_id=ProjectId(eq="project-a"),
        user_id=UserId(eq="user-a"),
        agent_id=AgentId(eq="agent-a"),
        session_id=SessionId(eq="session-a"),
        include_shared=True,
    )

    filters = request.get_filters()

    assert filters["project_id"].any == ["project-a", "__shared__"]
    assert filters["user_id"].any == ["user-a", "__shared__"]
    assert filters["agent_id"].any == ["agent-a", "__shared__"]
    assert filters["session_id"].any == ["session-a", "__shared__"]


def test_include_shared_rejects_scope_filters_that_are_not_positive_matches():
    with pytest.raises(ValidationError, match="include_shared supports exact or any"):
        SearchRequest(project_id=ProjectId(ne="project-a"), include_shared=True)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("project_id", "__shared__"),
        ("user_id", "__shared__"),
        ("agent_id", "__shared__"),
        ("session_id", "__shared__"),
    ],
)
def test_internal_shared_scope_value_is_rejected_on_writes(field, value):
    with pytest.raises(ValidationError, match="reserved for internal storage"):
        MemoryRecord(id="memory-1", text="private", **{field: value})


@pytest.mark.parametrize(
    "field",
    ["namespace", "project_id", "user_id", "agent_id", "session_id"],
)
def test_memory_record_rejects_commas_in_scalar_scope_values(field):
    with pytest.raises(ValidationError, match="must not contain commas"):
        MemoryRecord(
            id="memory-1",
            text="private",
            **{field: "scope-a,scope-b"},
        )


@pytest.mark.parametrize(
    ("model", "base", "field"),
    [
        (WorkingMemory, {"session_id": "safe"}, "project_id"),
        (WorkingMemory, {"session_id": "safe"}, "user_id"),
        (WorkingMemory, {"session_id": "safe"}, "agent_id"),
        (WorkingMemory, {"session_id": "safe"}, "session_id"),
        (UpdateWorkingMemory, {}, "project_id"),
        (UpdateWorkingMemory, {}, "user_id"),
        (UpdateWorkingMemory, {}, "agent_id"),
        (EditMemoryRecordRequest, {}, "project_id"),
        (EditMemoryRecordRequest, {}, "user_id"),
        (EditMemoryRecordRequest, {}, "agent_id"),
        (EditMemoryRecordRequest, {}, "session_id"),
    ],
)
def test_all_write_models_reject_commas_in_scalar_scope_values(model, base, field):
    with pytest.raises(ValidationError, match="must not contain commas"):
        model(**(base | {field: "scope-a,scope-b"}))


@pytest.mark.parametrize(
    "field",
    ["namespace", "project_id", "user_id", "agent_id", "session_id"],
)
def test_working_memory_nested_memories_cannot_bypass_scope_validation(field):
    with pytest.raises(ValidationError, match="must not contain commas"):
        UpdateWorkingMemory(
            memories=[
                {
                    "id": "memory-1",
                    "text": "private",
                    field: "scope-a,scope-b",
                }
            ]
        )


@pytest.mark.parametrize(
    "field",
    ["project_id", "user_id", "agent_id", "session_id"],
)
def test_working_memory_nested_memories_reject_internal_shared_scope(field):
    with pytest.raises(ValidationError, match="reserved for internal storage"):
        UpdateWorkingMemory(
            memories=[
                {
                    "id": "memory-1",
                    "text": "private",
                    field: "__shared__",
                }
            ]
        )


@pytest.mark.parametrize("field", ["project_id", "agent_id"])
def test_internal_shared_scope_value_is_rejected_on_edits(field):
    from agent_memory_server.models import EditMemoryRecordRequest

    with pytest.raises(ValidationError, match="reserved for internal storage"):
        EditMemoryRecordRequest(**{field: "__shared__"})


@pytest.mark.asyncio
async def test_core_search_passes_scope_and_namespace_filters_to_redisvl():
    database = AsyncMock()
    database.search_memories.return_value = MemoryRecordResults(memories=[], total=0)
    request = SearchRequest(
        text="archive flow",
        namespace={"eq": "coding/umony/archive"},
        inherit_parents=True,
        project_id={"eq": "project-a"},
        agent_id={"eq": "agent-a"},
    )

    with patch(
        "agent_memory_server.long_term_memory.get_memory_vector_db",
        new=AsyncMock(return_value=database),
    ):
        await search_long_term_memories(
            request.text,
            **request.get_filters(),
        )

    call = database.search_memories.await_args.kwargs
    assert call["project_id"].eq == "project-a"
    assert call["agent_id"].eq == "agent-a"
    assert call["namespace"].any == [
        "coding/umony/archive",
        "coding/umony",
        "coding",
    ]


def test_working_memory_passes_project_and_agent_scopes_to_the_session():
    update = UpdateWorkingMemory(project_id="project-a", agent_id="agent-a")

    working = update.to_working_memory("session-a")

    assert working.project_id == "project-a"
    assert working.agent_id == "agent-a"


def test_memory_hash_keeps_project_and_agent_deduplication_separate():
    base = {
        "id": "memory-1",
        "text": "same text",
        "namespace": "coding/umony",
        "user_id": "user-a",
        "session_id": "session-a",
    }

    project_a = MemoryRecord(**base, project_id="project-a", agent_id="agent-a")
    project_b = MemoryRecord(**base, project_id="project-b", agent_id="agent-a")
    agent_b = MemoryRecord(**base, project_id="project-a", agent_id="agent-b")

    assert generate_memory_hash(project_a) != generate_memory_hash(project_b)
    assert generate_memory_hash(project_a) != generate_memory_hash(agent_b)


@pytest.mark.asyncio
async def test_semantic_deduplication_is_exactly_scope_bound():
    database = AsyncMock()
    database.search_memories.return_value = MemoryRecordResults(memories=[], total=0)
    scoped = MemoryRecord(
        id="memory-1",
        text="same text",
        project_id="project-a",
        user_id=None,
        agent_id="agent-a",
        session_id="session-a",
        namespace="coding/umony",
    )

    with patch(
        "agent_memory_server.long_term_memory.get_memory_vector_db",
        new=AsyncMock(return_value=database),
    ):
        await deduplicate_by_semantic_search(scoped, redis_client=AsyncMock())

    filters = database.search_memories.await_args.kwargs
    assert filters["project_id"].eq == "project-a"
    assert filters["user_id"].eq == "__shared__"
    assert filters["agent_id"].eq == "agent-a"
    assert filters["session_id"].eq == "session-a"


@pytest.mark.asyncio
async def test_semantic_compaction_keeps_project_and_agent_on_each_anchor():
    database = AsyncMock()
    database.list_memories.return_value = MemoryRecordResults(
        memories=[
            {
                "id": "memory-1",
                "text": "private project fact",
                "namespace": "coding/umony",
                "project_id": "project-a",
                "user_id": "user-a",
                "agent_id": "agent-a",
                "session_id": "session-a",
                "dist": 0.0,
            }
        ],
        total=1,
    )
    semantic_deduplicate = AsyncMock(return_value=(None, False))

    with (
        patch(
            "agent_memory_server.long_term_memory.get_memory_vector_db",
            new=AsyncMock(return_value=database),
        ),
        patch(
            "agent_memory_server.long_term_memory.deduplicate_by_semantic_search",
            new=semantic_deduplicate,
        ),
        patch(
            "agent_memory_server.long_term_memory.count_long_term_memories",
            new=AsyncMock(return_value=1),
        ),
    ):
        await compact_long_term_memories(
            redis_client=AsyncMock(),
            compact_hash_duplicates=False,
            compact_semantic_duplicates=True,
        )

    semantic_call = semantic_deduplicate.await_args.kwargs
    anchor = semantic_call["memory"]
    assert anchor.project_id == "project-a"
    assert anchor.agent_id == "agent-a"
    assert semantic_call["project_id"] == "project-a"
    assert semantic_call["agent_id"] == "agent-a"
