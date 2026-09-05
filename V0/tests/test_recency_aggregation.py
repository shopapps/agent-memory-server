from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from redisvl.index import AsyncSearchIndex

from agent_memory_server.filters import ProjectId, UserId
from agent_memory_server.memory_vector_db import RedisVLMemoryVectorDatabase
from agent_memory_server.memory_vector_db_factory import _build_redis_schema
from agent_memory_server.models import MemoryRecordResult
from agent_memory_server.utils.recency import score_recency
from agent_memory_server.utils.redis_query import RecencyAggregationQuery


@pytest.mark.asyncio
async def test_recency_aggregation_query_builds_and_paginates():
    # Build a VectorQuery without touching Redis (pure construction)
    from redisvl.query import VectorQuery

    dummy_vec = [0.0, 0.0, 0.0]
    vq = VectorQuery(vector=dummy_vec, vector_field_name="vector", num_results=10)

    # Build aggregation
    agg = (
        RecencyAggregationQuery.from_vector_query(vq)
        .load_default_fields()
        .apply_recency(
            now_ts=1_700_000_000,
            params={
                "semantic_weight": 0.7,
                "recency_weight": 0.3,
                "freshness_weight": 0.5,
                "novelty_weight": 0.5,
                "half_life_last_access_days": 5.0,
                "half_life_created_days": 20.0,
            },
        )
        .sort_by_boosted_desc()
        .paginate(5, 7)
    )

    # Validate the aggregate request contains APPLY, SORTBY, and LIMIT via build_args
    args = agg.build_args()
    args_str = " ".join(map(str, args))
    assert "APPLY" in args_str
    assert "boosted_score" in args_str
    assert "SORTBY" in args_str
    assert "LIMIT" in args_str


@pytest.mark.asyncio
async def test_redis_adapter_uses_aggregation_when_server_side_recency():
    # Mock the AsyncSearchIndex
    mock_index = MagicMock()
    mock_index.exists = AsyncMock(return_value=True)
    mock_index.info = AsyncMock(
        return_value={
            "attributes": [{"attribute": "project_id"}, {"attribute": "agent_id"}]
        }
    )

    class Rows:
        def __init__(self, rows):
            self.rows = rows

    # Simulate aggregate returning rows from FT.AGGREGATE
    mock_index.aggregate = AsyncMock(
        return_value=Rows(
            [
                {
                    "id_": "m1",
                    "namespace": "ns",
                    "session_id": "s1",
                    "user_id": "u1",
                    "created_at": 1_700_000_000,
                    "last_accessed": 1_700_000_000,
                    "updated_at": 1_700_000_000,
                    "pinned": 0,
                    "access_count": 1,
                    "topics": "",
                    "entities": "",
                    "memory_hash": "h",
                    "discrete_memory_extracted": "t",
                    "memory_type": "semantic",
                    "persisted_at": None,
                    "extracted_from": "",
                    "event_date": None,
                    "text": "hello",
                    "vector_distance": 0.9,
                }
            ]
        )
    )

    # Mock embeddings
    mock_embeddings = MagicMock()
    mock_embeddings.aembed_query = AsyncMock(return_value=[0.0, 0.0, 0.0])

    db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

    results = await db.search_memories(
        query="hello",
        server_side_recency=True,
        namespace=None,
        limit=5,
        offset=0,
    )

    # Ensure we went through aggregate path
    assert mock_index.aggregate.await_count == 1
    assert len(results.memories) == 1
    assert results.memories[0].id == "m1"
    assert results.memories[0].text == "hello"


@pytest.mark.asyncio
async def test_redis_pinned_and_read_count_recency_match_python(requires_redis):
    schema = _build_redis_schema()
    identity = "pinned-recency-" + uuid4().hex
    schema["index"].update(name=identity, prefix=identity)
    index = AsyncSearchIndex.from_dict(schema, redis_client=requires_redis)
    await index.create()
    now = datetime(2026, 1, 1, tzinfo=UTC)
    old = now - timedelta(days=365)
    records = [
        MemoryRecordResult(
            id=identifier,
            text="Example fact",
            dist=0.2,
            created_at=created,
            last_accessed=created,
            pinned=pinned,
            project_id="project-example",
            agent_id="agent-example",
            metadata={"source": "test"},
        )
        for identifier, created, pinned in [
            ("old-pinned", old, True),
            ("new-pinned", now, True),
            ("old-unpinned", old, False),
            ("new-unpinned", now, False),
        ]
    ]
    records += [
        records[2].model_copy(update={"id": f"reads-{count}", "access_count": count})
        for count in [-1, 0, 1, 10, 100, 1000000]
    ]
    await index.load(
        [
            {
                "id_": record.id,
                "pinned": int(record.pinned),
                "created_at": record.created_at.timestamp(),
                "last_accessed": record.last_accessed.timestamp(),
                # Leave counts absent on original records to cover old hashes.
                **(
                    {"access_count": record.access_count}
                    if record.id.startswith("reads-")
                    else {}
                ),
            }
            for record in records
        ]
    )
    query = RecencyAggregationQuery("*")
    query.load("id_", "pinned", "created_at", "last_accessed", "access_count")
    query.apply(vector_distance="0.2")
    query.apply_recency(now_ts=int(now.timestamp()))
    result = await index.aggregate(query)
    embeddings = MagicMock()
    db = RedisVLMemoryVectorDatabase(index, embeddings)
    scores = {
        fields["id_"]: float(fields["recency"])
        for fields in map(db._coerce_aggregate_row, result.rows)
    }
    for record in records:
        assert scores[record.id] == pytest.approx(
            score_recency(record, now=now, params={})
        )
    assert scores["old-pinned"] == scores["new-pinned"] == 1.0
    assert scores["old-unpinned"] < scores["new-unpinned"]
    assert scores["old-unpinned"] == scores["reads--1"] == scores["reads-0"]
    assert (
        scores["reads-0"] < scores["reads-1"] < scores["reads-10"] < scores["reads-100"]
    )
    assert scores["reads-100"] == scores["reads-1000000"]

    # Invalid legacy counts are tested above, not written as valid memory models.
    records = [record for record in records if record.access_count >= 0]
    persisted_records = records + [
        records[0].model_copy(update={"id": "other-project", "project_id": "other"}),
        records[0].model_copy(update={"id": "other-user", "user_id": "private"}),
    ]
    embeddings.aembed_documents = AsyncMock(
        return_value=[[1.0] + [0.0] * 1535 for _ in persisted_records]
    )
    embeddings.aembed_query = AsyncMock(return_value=[1.0] + [0.0] * 1535)
    await db.add_memories(persisted_records)
    # Call the production aggregation path directly: fallback must not mask errors.
    result = await db._search_with_recency_aggregation(
        query="Example fact",
        redis_filter=db._build_filter_expression(
            project_id=ProjectId(eq="project-example"),
            user_id=UserId(eq="__shared__"),
        ),
        limit=len(records),
        offset=0,
        distance_threshold=None,
        recency_params={},
    )
    identifiers = [memory.id for memory in result.memories]
    assert len(identifiers) == len(records)
    assert set(identifiers) == {memory.id for memory in records}
    assert identifiers.index("old-pinned") < identifiers.index("old-unpinned")
    assert identifiers.index("reads-100") < identifiers.index("reads-0")
    assert all(memory.project_id == "project-example" for memory in result.memories)
    assert all(memory.agent_id == "agent-example" for memory in result.memories)
    assert all(memory.metadata == {"source": "test"} for memory in result.memories)
    assert all(
        memory.dist == pytest.approx(0, abs=0.000001) for memory in result.memories
    )
