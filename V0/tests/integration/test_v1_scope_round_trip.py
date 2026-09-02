import asyncio

import pytest
from redis.asyncio import Redis
from redisvl.index import AsyncSearchIndex

from agent_memory_server.config import settings
from agent_memory_server.filters import (
    AgentId,
    Id,
    Namespace,
    ProjectId,
    SessionId,
    UserId,
)
from agent_memory_server.memory_vector_db import RedisVLMemoryVectorDatabase
from agent_memory_server.memory_vector_db_factory import _build_redis_schema
from agent_memory_server.migrations import (
    SHARED_SCOPE_VALUE,
    _update_scope_fields_if_unchanged,
    migrate_add_scope_fields_5,
)
from agent_memory_server.models import MemoryRecord, SearchModeEnum, SearchRequest
from agent_memory_server.utils.recency import generate_memory_hash


class FakeEmbeddings:
    async def aembed_documents(self, texts):
        return [[0.1, 0.2, 0.3] for _ in texts]

    async def aembed_query(self, text):
        return [0.1, 0.2, 0.3]


class CoordinatedEmbeddings(FakeEmbeddings):
    def __init__(self, callers):
        self.callers = callers
        self.arrived = 0
        self.ready = asyncio.Event()

    async def aembed_documents(self, texts):
        self.arrived += 1
        if self.arrived == self.callers:
            self.ready.set()
        await asyncio.wait_for(self.ready.wait(), timeout=5)
        return await super().aembed_documents(texts)


def make_database(redis_url, suffix, embeddings=None):
    schema = _build_redis_schema()
    schema["index"]["name"] = f"v1_scope_{suffix}_idx"
    schema["index"]["prefix"] = f"v1_scope_{suffix}:"
    vector = next(field for field in schema["fields"] if field["name"] == "vector")
    vector["attrs"]["dims"] = 3
    index = AsyncSearchIndex.from_dict(schema, redis_url=redis_url)
    return RedisVLMemoryVectorDatabase(index, embeddings or FakeEmbeddings())


@pytest.mark.asyncio
async def test_scope_fields_round_trip_through_redisvl(redis_url, requires_redis):
    database = make_database(redis_url, "round_trip")
    await database.add_memories(
        [
            MemoryRecord(
                id="scope-round-trip",
                text="A private scoped memory",
                namespace="coding/umony",
                project_id="umony/archive-content-relay",
                user_id="paul",
                agent_id="codex",
                session_id="session-1",
            )
        ]
    )

    results = await database.list_memories(
        namespace=Namespace(eq="coding/umony"),
        project_id=ProjectId(eq="umony/archive-content-relay"),
        user_id=UserId(eq="paul"),
        agent_id=AgentId(eq="codex"),
        session_id=SessionId(eq="session-1"),
    )

    assert results.total == 1
    assert results.memories[0].project_id == "umony/archive-content-relay"
    assert results.memories[0].agent_id == "codex"


@pytest.mark.asyncio
async def test_global_memory_id_cannot_overwrite_another_scope(
    redis_url, requires_redis
):
    database = make_database(redis_url, "global_id_collision")
    first = MemoryRecord(
        id="global-id",
        text="Project A memory",
        namespace="coding/a",
        project_id="project-a",
        user_id="user-a",
        agent_id="agent-a",
        session_id="session-a",
    )
    collision = first.model_copy(
        update={"text": "Project B memory", "project_id": "project-b"}
    )
    same_scope_update = first.model_copy(update={"text": "Updated Project A memory"})

    await database.add_memories([first])
    await database.add_memories([same_scope_update])

    with pytest.raises(ValueError, match="already exists in a different scope"):
        await database.add_memories([collision])

    stored = await database.list_memories(id=Id(eq="global-id"))
    assert stored.total == 1
    assert stored.memories[0].text == "Updated Project A memory"
    assert stored.memories[0].project_id == "project-a"


@pytest.mark.asyncio
async def test_concurrent_global_memory_id_keeps_one_scope_owner(
    redis_url, requires_redis
):
    embeddings = CoordinatedEmbeddings(callers=2)
    first_database = make_database(redis_url, "concurrent_global_id", embeddings)
    second_database = make_database(redis_url, "concurrent_global_id", embeddings)
    await first_database._ensure_index()

    first = MemoryRecord(
        id="concurrent-global-id",
        text="Project A memory",
        namespace="coding/a",
        project_id="project-a",
    )
    second = first.model_copy(
        update={
            "text": "Project B memory",
            "namespace": "coding/b",
            "project_id": "project-b",
        }
    )

    outcomes = await asyncio.gather(
        first_database.add_memories([first]),
        second_database.add_memories([second]),
        return_exceptions=True,
    )

    successes = [outcome for outcome in outcomes if isinstance(outcome, list)]
    failures = [outcome for outcome in outcomes if isinstance(outcome, Exception)]
    assert successes == [["concurrent-global-id"]]
    assert len(failures) == 1
    assert isinstance(failures[0], ValueError)
    assert "already exists in a different scope" in str(failures[0])

    winner = first if isinstance(outcomes[0], list) else second
    stored = await first_database.list_memories(id=Id(eq="concurrent-global-id"))
    assert stored.total == 1
    assert stored.memories[0].text == winner.text
    assert stored.memories[0].namespace == winner.namespace
    assert stored.memories[0].project_id == winner.project_id


@pytest.mark.asyncio
async def test_default_scope_filters_return_only_fully_shared_memories(
    redis_url, requires_redis
):
    database = make_database(redis_url, "shared_only_default")
    common = {"namespace": "coding/shared", "text": "scope default"}
    await database.add_memories(
        [
            MemoryRecord(id="fully-shared", **common),
            MemoryRecord(id="private-project", project_id="project-a", **common),
            MemoryRecord(id="private-user", user_id="user-a", **common),
            MemoryRecord(id="private-agent", agent_id="agent-a", **common),
            MemoryRecord(id="private-session", session_id="session-a", **common),
        ]
    )
    request = SearchRequest(namespace=Namespace(eq="coding/shared"))

    results = await database.list_memories(**request.get_filters())

    assert [memory.id for memory in results.memories] == ["fully-shared"]


@pytest.mark.asyncio
@pytest.mark.parametrize("search_mode", list(SearchModeEnum))
async def test_search_modes_isolate_scopes_and_do_not_search_sideways(
    redis_url, requires_redis, search_mode
):
    database = make_database(redis_url, f"isolation_{search_mode.value}")
    common = {
        "namespace": "coding/umony/archive",
        "project_id": "project-a",
        "user_id": "user-a",
        "agent_id": "agent-a",
        "session_id": "session-a",
    }
    variants = [
        ("allowed-child", {}),
        ("allowed-parent", {"namespace": "coding/umony"}),
        (
            "shared",
            {
                "project_id": None,
                "user_id": None,
                "agent_id": None,
                "session_id": None,
            },
        ),
        ("other-namespace", {"namespace": "coding/laravel"}),
        ("other-project", {"project_id": "project-b"}),
        ("other-user", {"user_id": "user-b"}),
        ("other-agent", {"agent_id": "agent-b"}),
        ("other-session", {"session_id": "session-b"}),
    ]
    await database.add_memories(
        [
            MemoryRecord(
                id=memory_id,
                text=f"scope isolation {memory_id}",
                **(common | overrides),
            )
            for memory_id, overrides in variants
        ]
    )
    request = SearchRequest(
        text="scope isolation",
        search_mode=search_mode,
        namespace=Namespace(eq="coding/umony/archive"),
        inherit_parents=True,
        project_id=ProjectId(eq="project-a"),
        user_id=UserId(eq="user-a"),
        agent_id=AgentId(eq="agent-a"),
        session_id=SessionId(eq="session-a"),
        include_shared=True,
    )

    results = await database.search_memories(
        query=request.text,
        search_mode=search_mode,
        **request.get_filters(),
    )

    assert {memory.id for memory in results.memories} == {
        "allowed-child",
        "allowed-parent",
        "shared",
    }


@pytest.mark.asyncio
async def test_scope_migration_makes_legacy_shared_memory_searchable_and_rehashes_it(
    redis_url, requires_redis, monkeypatch
):
    prefix = "v1_scope_migration"
    monkeypatch.setattr(settings, "redisvl_index_prefix", prefix)
    database = make_database(redis_url, "migration")
    memory = MemoryRecord(
        id="legacy-shared",
        text="legacy shared memory",
        namespace="coding/umony",
    )
    await database.add_memories([memory])

    redis = Redis.from_url(redis_url)
    key = f"{prefix}:legacy-shared"
    await redis.hdel(key, "project_id", "user_id", "agent_id", "session_id")
    await redis.hset(key, "memory_hash", "legacy-hash")

    await migrate_add_scope_fields_5(redis=redis)

    request = SearchRequest(
        namespace=Namespace(eq="coding/umony"),
        include_shared=True,
    )
    results = await database.list_memories(**request.get_filters())

    assert [item.id for item in results.memories] == ["legacy-shared"]
    stored_hash = await redis.hget(key, "memory_hash")
    assert stored_hash is not None
    assert stored_hash.decode() == generate_memory_hash(memory)
    await redis.aclose()


@pytest.mark.asyncio
async def test_scope_migration_does_not_overwrite_a_concurrent_private_write(
    redis_url, requires_redis
):
    redis = Redis.from_url(redis_url, decode_responses=True)
    key = "memory_idx:v1-scope-migration-race"
    await redis.hset(key, mapping={"text": "legacy memory"})
    snapshot = {"text": "legacy memory"}

    await redis.hset(key, "project_id", "private-project")
    changed = await _update_scope_fields_if_unchanged(
        redis,
        key,
        snapshot,
        {"project_id": SHARED_SCOPE_VALUE},
    )

    assert changed is False
    assert await redis.hget(key, "project_id") == "private-project"
    await redis.aclose()
