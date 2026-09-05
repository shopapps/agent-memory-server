"""Tests for the MemoryVectorDatabase abstraction."""

import asyncio
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
from redisvl.index import AsyncSearchIndex

from agent_memory_server.filters import (
    AgentId,
    ExtractionStrategy,
    ProjectId,
    SessionId,
    UserId,
)
from agent_memory_server.long_term_memory import (
    get_long_term_memory_by_id,
    get_long_term_memory_history,
    restore_long_term_memories,
    undo_long_term_memory,
    update_long_term_memory,
)
from agent_memory_server.memory_vector_db import (
    MemoryVectorDatabase,
    MemoryVersionConflictError,
    PhraseAwareAggregateHybridQuery,
    PhraseAwareTextQuery,
    RedisVLMemoryVectorDatabase,
)
from agent_memory_server.memory_vector_db_factory import (
    _build_redis_schema,
    create_embeddings,
    create_memory_vector_db,
)
from agent_memory_server.models import (
    MemoryRecord,
    MemoryRecordResults,
    MemoryTypeEnum,
    SearchModeEnum,
)


class MockEmbeddings:
    """Mock embeddings for testing."""

    def __init__(self, dimensions: int = 1536):
        self.dimensions = dimensions
        self._dimensions = dimensions
        self.model = "mock-embedding-model"

    def embed_documents(self, texts):
        return [[0.1] * self.dimensions for _ in texts]

    def embed_query(self, text):
        return [0.1] * self.dimensions

    async def aembed_documents(self, texts):
        return [[0.1] * self.dimensions for _ in texts]

    async def aembed_query(self, text):
        return [0.1] * self.dimensions


class TestMemoryVectorDatabase:
    """Test cases for MemoryVectorDatabase functionality."""

    @pytest.mark.asyncio
    async def test_filter_listing_pages_all_shared_project_facts(self, requires_redis):
        schema = _build_redis_schema()
        identity = "pagination-test-" + uuid4().hex
        schema["index"].update(name=identity, prefix=identity)
        db = RedisVLMemoryVectorDatabase(
            AsyncSearchIndex.from_dict(schema, redis_client=requires_redis),
            MockEmbeddings(),
        )
        records = [
            MemoryRecord(
                id=f"fact-{number}", text=f"Convention {number}", project_id="project-a"
            )
            for number in range(101)
        ]
        await db.add_memories(
            records
            + [
                MemoryRecord(
                    id="private-fact",
                    text="Private context",
                    project_id="project-a",
                    user_id="private-user",
                ),
                MemoryRecord(
                    id="other-project", text="Other context", project_id="project-b"
                ),
            ]
        )
        filters = {
            "project_id": ProjectId(eq="project-a"),
            "user_id": UserId(eq="__shared__"),
            "agent_id": AgentId(eq="__shared__"),
            "session_id": SessionId(eq="__shared__"),
        }
        first = await db.list_memories(limit=100, **filters)
        assert len(first.memories) == 100
        assert first.next_offset == 100
        second = await db.list_memories(limit=100, offset=first.next_offset, **filters)
        assert len(second.memories) == 1
        assert second.next_offset is None
        assert second.total == 101
        assert {memory.id for memory in first.memories + second.memories} == {
            memory.id for memory in records
        }

    @pytest.mark.asyncio
    async def test_restore_is_shared_project_only_and_create_only(self, requires_redis):
        schema = _build_redis_schema()
        identity = "restore-test-" + uuid4().hex
        schema["index"].update(name=identity, prefix=identity)
        db = RedisVLMemoryVectorDatabase(
            AsyncSearchIndex.from_dict(schema, redis_client=requires_redis),
            MockEmbeddings(),
        )
        record = MemoryRecord(id="restored", text="PHP 8.4", project_id="project-a")
        await db._ensure_index()
        with patch(
            "agent_memory_server.long_term_memory.get_memory_vector_db", return_value=db
        ):
            outcomes = await asyncio.gather(
                *[restore_long_term_memories("project-a", [record]) for _ in range(2)],
                return_exceptions=True,
            )
            assert outcomes.count(1) == 1
            assert (
                sum(
                    isinstance(result, MemoryVersionConflictError)
                    for result in outcomes
                )
                == 1
            ), outcomes
            persisted = await get_long_term_memory_by_id("restored")
            assert persisted.created_at == record.created_at
            assert persisted.updated_at == record.updated_at
            fresh = record.model_copy(update={"id": "fresh"})
            with pytest.raises(MemoryVersionConflictError):
                await restore_long_term_memories(
                    "project-a",
                    [fresh, record.model_copy(update={"text": "Wrong replacement"})],
                )
            assert await get_long_term_memory_by_id("fresh") is None
            assert (await get_long_term_memory_by_id("restored")).text == "PHP 8.4"
            for changed in [
                {"project_id": "other-project"},
                {"user_id": "private"},
                {"agent_id": "private"},
                {"session_id": "private"},
            ]:
                with pytest.raises(ValueError, match="shared facts"):
                    await restore_long_term_memories(
                        "project-a", [fresh.model_copy(update=changed)]
                    )

    @pytest.mark.asyncio
    async def test_edit_history_undo_and_concurrent_versions(self, requires_redis):
        schema = _build_redis_schema()
        identity = "history-test-" + uuid4().hex
        schema["index"].update(name=identity, prefix=identity)
        index = AsyncSearchIndex.from_dict(schema, redis_client=requires_redis)
        embeddings = MockEmbeddings()
        embeddings.aembed_documents = AsyncMock(wraps=embeddings.aembed_documents)
        db = RedisVLMemoryVectorDatabase(index, embeddings)
        original = MemoryRecord(
            id="fact",
            text="PHP 8.3 legacy83",
            project_id="private-project",
            user_id="private-user",
            metadata={"source": "checked-file"},
        )
        await db.add_memories([original])
        with patch(
            "agent_memory_server.long_term_memory.get_memory_vector_db", return_value=db
        ):
            first = await get_long_term_memory_by_id("fact")
            assert (
                first.updated_at
                == db._data_to_memory_result(await index.fetch("fact")).updated_at
            )
            changed = await update_long_term_memory(
                "fact", {"text": "PHP 8.4 current84"}, expected_version=first.updated_at
            )
            assert changed.updated_at > first.updated_at
            history = await get_long_term_memory_history("fact")
            assert history.entries[0].fields["text"] == original.text
            assert history.entries[0].metadata == original.metadata
            assert not (
                await db.search_memories("legacy83", search_mode=SearchModeEnum.KEYWORD)
            ).memories
            assert (
                len(
                    (
                        await db.search_memories(
                            "current84", search_mode=SearchModeEnum.KEYWORD
                        )
                    ).memories
                )
                == 1
            )
            restored = await undo_long_term_memory(
                "fact", first.updated_at, changed.updated_at
            )
            assert restored.text == original.text
            assert embeddings.aembed_documents.await_args.args[0] == [original.text]
            assert restored.updated_at > changed.updated_at
            outcomes = await asyncio.gather(
                *[
                    update_long_term_memory(
                        "fact", {"text": text}, expected_version=restored.updated_at
                    )
                    for text in ("First concurrent edit", "Second concurrent edit")
                ],
                return_exceptions=True,
            )
            assert (
                sum(
                    isinstance(result, MemoryVersionConflictError)
                    for result in outcomes
                )
                == 1
            )
            current = await get_long_term_memory_by_id("fact")
            # A repeated/backwards clock still produces a distinct edit version.
            clock = MagicMock(wraps=datetime)
            clock.now.return_value = current.updated_at
            with patch("agent_memory_server.long_term_memory.datetime", clock):
                tick = await update_long_term_memory(
                    "fact", {"pinned": True}, expected_version=current.updated_at
                )
            assert tick.updated_at > current.updated_at
            for number in range(22):
                await update_long_term_memory("fact", {"text": f"Revision {number}"})
            assert len((await get_long_term_memory_history("fact")).entries) == 20
            current = await get_long_term_memory_by_id("fact")
            assert (
                await db.get_memory_history(
                    current.model_copy(update={"project_id": "other-project"})
                )
                == []
            )
            assert await requires_redis.llen(db._history_key("fact")) == 20
            # Reusing an ID must not reveal private old fields or allow old undo.
            assert await db.delete_memories(["fact"]) == 1
            assert await requires_redis.exists(db._history_key("fact")) == 0
            await db.add_memories(
                [
                    MemoryRecord(
                        id="fact", text="New shared fact", project_id="public-project"
                    )
                ]
            )
            assert (await get_long_term_memory_history("fact")).entries == []
            reused = await get_long_term_memory_by_id("fact")
            with pytest.raises(ValueError, match="not available"):
                await undo_long_term_memory("fact", first.updated_at, reused.updated_at)
            # An unrelated overwrite breaks the revision chain, even with the same scope and creation date.
            await update_long_term_memory("fact", {"text": "Shared correction"})
            replacement = reused.model_copy(
                update={
                    "text": "Unrelated replacement",
                    "updated_at": datetime.now(UTC) + timedelta(seconds=1),
                }
            )
            await db.add_memories([replacement])
            assert (await get_long_term_memory_history("fact")).entries == []
            await update_long_term_memory("fact", {"text": "Correction to replacement"})
            assert len((await get_long_term_memory_history("fact")).entries) == 1

    @pytest.mark.asyncio
    async def test_existing_index_is_rebuilt_for_v1_scope_fields(self):
        """An old search index should gain the new scope fields in place."""
        mock_index = MagicMock()
        mock_index.exists = AsyncMock(return_value=True)
        mock_index.info = AsyncMock(
            return_value={
                "attributes": [["identifier", "session_id", "attribute", "session_id"]]
            }
        )
        mock_index.create = AsyncMock()

        db = RedisVLMemoryVectorDatabase(mock_index, MockEmbeddings())

        await db._ensure_index()

        mock_index.create.assert_awaited_once_with(overwrite=True, drop=False)

    @pytest.mark.asyncio
    async def test_existing_v1_index_is_left_alone(self):
        """A current search index should not be rebuilt on first use."""
        mock_index = MagicMock()
        mock_index.exists = AsyncMock(return_value=True)
        mock_index.info = AsyncMock(
            return_value={
                "attributes": [
                    ["identifier", "project_id", "attribute", "project_id"],
                    ["identifier", "agent_id", "attribute", "agent_id"],
                ]
            }
        )
        mock_index.create = AsyncMock()

        db = RedisVLMemoryVectorDatabase(mock_index, MockEmbeddings())

        await db._ensure_index()

        mock_index.create.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_concurrent_index_upgrade_accepts_other_process_success(self):
        """A losing upgrader should accept the schema created by its peer."""
        mock_index = MagicMock()
        mock_index.exists = AsyncMock(return_value=True)
        mock_index.info = AsyncMock(
            side_effect=[
                {"attributes": [{"attribute": "session_id"}]},
                {
                    "attributes": [
                        {"attribute": "project_id"},
                        {"attribute": "agent_id"},
                    ]
                },
            ]
        )
        mock_index.create = AsyncMock(side_effect=RuntimeError("index changed"))

        db = RedisVLMemoryVectorDatabase(mock_index, MockEmbeddings())

        await db._ensure_index()

        assert db._index_created is True

    def test_memory_hash_generation(self):
        """Test memory hash generation."""
        # Create a concrete implementation for testing
        mock_index = MagicMock()
        mock_embeddings = MockEmbeddings()

        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        # Create a sample memory
        memory = MemoryRecord(
            text="This is a test memory",
            id="test-hash-123",
            user_id="user-123",
            session_id="session-456",
            memory_type=MemoryTypeEnum.SEMANTIC,
        )

        # Generate hash
        hash1 = db.generate_memory_hash(memory)
        hash2 = db.generate_memory_hash(memory)

        # Verify hash is stable
        assert hash1 == hash2
        assert len(hash1) == 64  # SHA256 hex digest

        # Verify different memories produce different hashes
        different_memory = MemoryRecord(
            text="This is a different memory",
            id="test-hash-456",
            user_id="user-123",
            session_id="session-456",
            memory_type=MemoryTypeEnum.SEMANTIC,
        )
        different_hash = db.generate_memory_hash(different_memory)
        assert hash1 != different_hash

    def test_parse_list_field(self):
        """Test parsing of list fields."""
        mock_index = MagicMock()
        mock_embeddings = MockEmbeddings()
        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        # Test with None
        assert db._parse_list_field(None) == []

        # Test with empty string
        assert db._parse_list_field("") == []

        # Test with comma-separated string
        assert db._parse_list_field("a,b,c") == ["a", "b", "c"]

        # Test with legacy pipe-separated string
        assert db._parse_list_field("a|b|c") == ["a", "b", "c"]

        # Test with list
        assert db._parse_list_field(["a", "b"]) == ["a", "b"]

    def test_memory_to_data_conversion(self):
        """Test converting MemoryRecord to data dict."""
        mock_index = MagicMock()
        mock_embeddings = MockEmbeddings()
        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        memory = MemoryRecord(
            text="This is a test memory",
            id="test-123",
            session_id="session-456",
            user_id="user-789",
            namespace="test",
            topics=["testing", "memory"],
            entities=["test"],
            memory_type=MemoryTypeEnum.SEMANTIC,
            extraction_strategy="summary",
            extraction_strategy_config={"summary_version": "v1"},
            metadata={"source_session_id": "session-456", "message_count": 2},
        )

        data = db._memory_to_data(memory)

        assert data["text"] == "This is a test memory"
        assert data["id_"] == "test-123"
        assert data["session_id"] == "session-456"
        assert data["user_id"] == "user-789"
        assert data["namespace"] == "test"
        assert data["topics"] == "testing,memory"
        assert data["entities"] == "test"
        assert data["memory_type"] == "semantic"
        assert data["extraction_strategy"] == "summary"
        assert '"summary_version": "v1"' in data["extraction_strategy_config"]
        assert '"message_count": 2' in data["metadata"]

    def test_data_to_memory_result_conversion(self):
        """Test converting data dict to MemoryRecordResult."""
        mock_index = MagicMock()
        mock_embeddings = MockEmbeddings()
        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        fields = {
            "id_": "test-123",
            "text": "This is a test memory",
            "session_id": "session-456",
            "user_id": "user-789",
            "namespace": "test",
            "topics": "testing,memory",
            "entities": "test",
            "memory_type": "semantic",
            "extraction_strategy": "summary",
            "extraction_strategy_config": '{"summary_version":"v1"}',
            "metadata": '{"source_session_id":"session-456","message_count":2}',
            "created_at": "1704067200",  # 2024-01-01T00:00:00Z
            "last_accessed": "1704067200",
            "updated_at": "1704067200",
            "discrete_memory_extracted": "t",
        }

        result = db._data_to_memory_result(fields, score=0.2)

        assert result.text == "This is a test memory"
        assert result.id == "test-123"
        assert result.session_id == "session-456"
        assert result.user_id == "user-789"
        assert result.namespace == "test"
        assert result.topics == ["testing", "memory"]
        assert result.entities == ["test"]
        assert result.memory_type == "semantic"
        assert result.extraction_strategy == "summary"
        assert result.extraction_strategy_config == {"summary_version": "v1"}
        assert result.metadata == {
            "source_session_id": "session-456",
            "message_count": 2,
        }
        assert result.dist == 0.2
        assert result.discrete_memory_extracted == "t"

    def test_data_to_memory_result_preserves_empty_extraction_strategy(self):
        """Explicit empty extraction_strategy should not trigger legacy fallback."""
        mock_index = MagicMock()
        mock_embeddings = MockEmbeddings()
        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        result = db._data_to_memory_result(
            {
                "id_": "test-123",
                "text": "This is a test memory",
                "memory_type": "semantic",
                "extraction_strategy": "",
            }
        )

        assert result.extraction_strategy == ""

    def test_data_to_memory_result_defaults_missing_extraction_strategy(self):
        """Missing extraction_strategy should retain legacy read defaults."""
        mock_index = MagicMock()
        mock_embeddings = MockEmbeddings()
        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        semantic_result = db._data_to_memory_result(
            {
                "id_": "semantic-123",
                "text": "This is a semantic memory",
                "memory_type": "semantic",
            }
        )
        message_result = db._data_to_memory_result(
            {
                "id_": "message-123",
                "text": "This is a message memory",
                "memory_type": "message",
            }
        )

        assert semantic_result.extraction_strategy == "discrete"
        assert message_result.extraction_strategy == "message"

    def test_redis_schema_includes_extraction_metadata_fields(self):
        """RedisVL schema should expose extraction strategy fields."""
        schema = _build_redis_schema()
        fields = {field["name"]: field for field in schema["fields"]}

        assert fields["extraction_strategy"]["type"] == "tag"
        assert fields["extraction_strategy_config"]["type"] == "text"
        assert fields["metadata"]["type"] == "text"

    def test_build_filter_expression_supports_extraction_strategy(self):
        """The RedisVL filter expression should include extraction_strategy."""
        mock_index = MagicMock()
        mock_embeddings = MockEmbeddings()
        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        expression = db._build_filter_expression(
            extraction_strategy=ExtractionStrategy(eq="summary")
        )

        assert "extraction_strategy" in str(expression)
        assert "summary" in str(expression)

    @pytest.mark.asyncio
    async def test_add_memories_with_mock_index(self):
        """Test adding memories to a mock index."""
        mock_index = MagicMock()
        mock_index.exists = AsyncMock(return_value=True)
        mock_index.info = AsyncMock(
            return_value={
                "attributes": [{"attribute": "project_id"}, {"attribute": "agent_id"}]
            }
        )
        mock_index.load = AsyncMock(return_value=["key1", "key2"])
        mock_index.fetch = AsyncMock(return_value=None)
        mock_embeddings = MockEmbeddings()

        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        memories = [
            MemoryRecord(
                text="Memory 1",
                id="mem1",
                memory_type=MemoryTypeEnum.SEMANTIC,
            ),
            MemoryRecord(
                text="Memory 2",
                id="mem2",
                memory_type=MemoryTypeEnum.SEMANTIC,
            ),
        ]

        ids = await db.add_memories(memories)

        assert ids == ["mem1", "mem2"]
        mock_index.load.assert_called_once()

    @pytest.mark.asyncio
    async def test_empty_memories_handling(self):
        """Test handling of empty memory lists."""
        mock_index = MagicMock()
        mock_embeddings = MockEmbeddings()

        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        # Test adding empty list
        ids = await db.add_memories([])
        assert ids == []

        # Test deleting empty list
        deleted = await db.delete_memories([])
        assert deleted == 0

    @pytest.mark.asyncio
    async def test_update_memories(self):
        """Test update_memories method calls add_memories."""
        mock_index = MagicMock()
        mock_index.exists = AsyncMock(return_value=True)
        mock_index.info = AsyncMock(
            return_value={
                "attributes": [{"attribute": "project_id"}, {"attribute": "agent_id"}]
            }
        )
        mock_index.load = AsyncMock(return_value=["key1", "key2"])
        mock_index.fetch = AsyncMock(return_value=None)
        mock_embeddings = MockEmbeddings()

        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        memories = [
            MemoryRecord(
                text="Updated memory 1",
                id="mem1",
                memory_type=MemoryTypeEnum.SEMANTIC,
                discrete_memory_extracted="t",
            ),
            MemoryRecord(
                text="Updated memory 2",
                id="mem2",
                memory_type=MemoryTypeEnum.SEMANTIC,
                discrete_memory_extracted="t",
            ),
        ]

        count = await db.update_memories(memories)

        # update_memories delegates to add_memories
        mock_index.load.assert_called_once()
        assert count == 2

    @pytest.mark.asyncio
    async def test_update_memories_empty_list(self):
        """Test update_memories with empty list."""
        mock_index = MagicMock()
        mock_embeddings = MockEmbeddings()

        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        count = await db.update_memories([])
        assert count == 0

    @pytest.mark.asyncio
    async def test_delete_memories(self):
        """Delete current keys and history, but count only current facts."""
        mock_index = MagicMock()
        mock_index.exists = AsyncMock(return_value=True)
        mock_index.info = AsyncMock(
            return_value={
                "attributes": [{"attribute": "project_id"}, {"attribute": "agent_id"}]
            }
        )
        mock_index.key.side_effect = lambda memory_id: f"memory:{memory_id}"
        pipeline = MagicMock()
        pipeline.__aenter__.return_value = pipeline
        pipeline.execute = AsyncMock(return_value=[1, 1, 1, 0])
        mock_index.client.pipeline.return_value = pipeline
        mock_embeddings = MockEmbeddings()

        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        deleted = await db.delete_memories(["mem1", "mem2"])

        assert [call.args[0] for call in pipeline.delete.call_args_list] == [
            "memory:mem1",
            db._history_key("mem1"),
            "memory:mem2",
            db._history_key("mem2"),
        ]
        assert deleted == 2

    @pytest.mark.asyncio
    async def test_search_memories_keyword_mode_uses_text_query(self):
        """Test keyword search uses TextQuery and normalizes scores."""
        mock_index = MagicMock()
        mock_index.exists = AsyncMock(return_value=True)
        mock_index.info = AsyncMock(
            return_value={
                "attributes": [{"attribute": "project_id"}, {"attribute": "agent_id"}]
            }
        )
        mock_index.query = AsyncMock(
            return_value=[
                {
                    "id_": "mem1",
                    "text": "alpha beta",
                    "memory_type": "semantic",
                    "score": "4.0",
                },
                {
                    "id_": "mem2",
                    "text": "alpha",
                    "memory_type": "semantic",
                    "score": "2.0",
                },
            ]
        )
        mock_embeddings = MockEmbeddings()
        mock_embeddings.aembed_query = AsyncMock(return_value=[0.1] * 1536)

        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        results = await db.search_memories(
            query="alpha",
            search_mode=SearchModeEnum.KEYWORD,
            limit=10,
        )

        assert results.total == 2
        assert results.memories[0].score == pytest.approx(1.0)
        assert results.memories[0].dist == pytest.approx(0.0)
        assert results.memories[0].score_type == "keyword"
        assert results.memories[1].score == pytest.approx(0.5)
        assert results.memories[1].dist == pytest.approx(0.5)
        mock_index.query.assert_called_once()
        mock_embeddings.aembed_query.assert_not_called()

    @pytest.mark.asyncio
    async def test_search_memories_hybrid_mode_uses_aggregate_hybrid_query(self):
        """Test hybrid search uses aggregate queries and normalizes scores."""
        mock_index = MagicMock()
        mock_index.exists = AsyncMock(return_value=True)
        mock_index.info = AsyncMock(
            return_value={
                "attributes": [{"attribute": "project_id"}, {"attribute": "agent_id"}]
            }
        )
        mock_index.aggregate = AsyncMock(
            return_value=MagicMock(
                rows=[
                    {
                        "id_": "mem1",
                        "text": "alpha beta",
                        "memory_type": "semantic",
                        "hybrid_score": "3.0",
                    },
                    {
                        "id_": "mem2",
                        "text": "alpha",
                        "memory_type": "semantic",
                        "hybrid_score": "1.5",
                    },
                ]
            )
        )
        mock_embeddings = MockEmbeddings()
        mock_embeddings.aembed_query = AsyncMock(return_value=[0.1] * 1536)

        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        results = await db.search_memories(
            query="alpha",
            search_mode=SearchModeEnum.HYBRID,
            hybrid_alpha=0.6,
            text_scorer="BM25",
            limit=10,
        )

        assert results.total == 2
        assert results.memories[0].score == pytest.approx(1.0)
        assert results.memories[0].score_type == "hybrid"
        assert results.memories[1].score == pytest.approx(0.5)
        mock_index.aggregate.assert_called_once()
        mock_embeddings.aembed_query.assert_called_once_with("alpha")

    @pytest.mark.asyncio
    async def test_search_memories_hybrid_mode_parses_aggregate_lists(self):
        """Test hybrid search handles alternating key/value aggregate rows."""
        mock_index = MagicMock()
        mock_index.exists = AsyncMock(return_value=True)
        mock_index.info = AsyncMock(
            return_value={
                "attributes": [{"attribute": "project_id"}, {"attribute": "agent_id"}]
            }
        )
        mock_index.aggregate = AsyncMock(
            return_value=MagicMock(
                rows=[
                    [
                        b"id_",
                        b"mem1",
                        b"text",
                        b"scarlet dolphin",
                        b"memory_type",
                        b"message",
                        b"hybrid_score",
                        b"2.0",
                    ],
                    [
                        b"id_",
                        b"mem2",
                        b"text",
                        b"scarlet bird",
                        b"memory_type",
                        b"message",
                        b"hybrid_score",
                        b"1.0",
                    ],
                ]
            )
        )
        mock_embeddings = MockEmbeddings()
        mock_embeddings.aembed_query = AsyncMock(return_value=[0.1] * 1536)

        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        results = await db.search_memories(
            query="scarlet dolphin",
            search_mode=SearchModeEnum.HYBRID,
            limit=10,
        )

        assert results.total == 2
        assert results.memories[0].id == "mem1"
        assert results.memories[0].score == pytest.approx(1.0)
        assert results.memories[1].id == "mem2"
        assert results.memories[1].score == pytest.approx(0.5)

    def test_phrase_aware_text_query_preserves_quoted_phrases(self):
        """Quoted strings should become Redis phrase clauses."""
        query = PhraseAwareTextQuery(
            text='"scarlet dolphin" orchard',
            text_field_name="text",
            stopwords=None,
        )

        assert '@text:("scarlet dolphin" | orchard)' in str(query)

    def test_phrase_aware_hybrid_query_preserves_quoted_phrases(self):
        """Hybrid query should require quoted phrases and keep terms optional."""
        query = PhraseAwareAggregateHybridQuery(
            text='"scarlet dolphin" orchard',
            text_field_name="text",
            vector=[0.1] * 1536,
            vector_field_name="vector",
            stopwords=None,
        )

        assert '(@text:("scarlet dolphin") ~@text:(orchard))' in str(query)

    @pytest.mark.asyncio
    async def test_search_memories_hybrid_mode_uses_strict_phrases(self):
        """Quoted phrases in hybrid mode should become required lexical clauses."""
        mock_index = MagicMock()
        mock_index.exists = AsyncMock(return_value=True)
        mock_index.info = AsyncMock(
            return_value={
                "attributes": [{"attribute": "project_id"}, {"attribute": "agent_id"}]
            }
        )
        mock_index.aggregate = AsyncMock(return_value=MagicMock(rows=[]))
        mock_embeddings = MockEmbeddings()
        mock_embeddings.aembed_query = AsyncMock(return_value=[0.1] * 1536)

        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        await db.search_memories(
            query='"scarlet dolphin" orchard',
            search_mode=SearchModeEnum.HYBRID,
            limit=10,
        )

        aggregate_query = mock_index.aggregate.call_args.args[0]
        assert '(@text:("scarlet dolphin") ~@text:(orchard))' in str(aggregate_query)

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("search_mode", "mode_name"),
        [
            (SearchModeEnum.KEYWORD, "keyword"),
            (SearchModeEnum.HYBRID, "hybrid"),
        ],
    )
    async def test_search_memories_warns_when_server_side_recency_is_nonsemantic(
        self, caplog, search_mode, mode_name
    ):
        """Non-semantic searches should log when server-side recency degrades."""
        mock_index = MagicMock()
        mock_index.exists = AsyncMock(return_value=True)
        mock_index.info = AsyncMock(
            return_value={
                "attributes": [{"attribute": "project_id"}, {"attribute": "agent_id"}]
            }
        )
        mock_index.query = AsyncMock(return_value=[])
        mock_index.aggregate = AsyncMock(return_value=MagicMock(rows=[]))
        mock_embeddings = MockEmbeddings()

        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        await db.search_memories(
            query="scarlet dolphin",
            search_mode=search_mode,
            server_side_recency=True,
            limit=10,
        )

        assert (
            "server_side_recency is only supported for semantic search; "
            f"falling back to client-side reranking for {mode_name} search"
        ) in caplog.text
        if search_mode == SearchModeEnum.KEYWORD:
            mock_index.aggregate.assert_not_called()
        else:
            mock_index.query.assert_not_called()

    @pytest.mark.asyncio
    async def test_factory_creates_redisvl_db(self):
        """Test that the factory creates a RedisVLMemoryVectorDatabase."""
        import agent_memory_server.memory_vector_db_factory

        # Clear the global instance to force recreation
        agent_memory_server.memory_vector_db_factory._memory_vector_db = None

        # Mock embeddings to avoid API key requirement
        with patch(
            "agent_memory_server.memory_vector_db_factory.create_embeddings"
        ) as mock_create_embeddings:
            mock_create_embeddings.return_value = MockEmbeddings()

            db = create_memory_vector_db()

            # Should get RedisVLMemoryVectorDatabase
            assert isinstance(db, RedisVLMemoryVectorDatabase)

        # Reset the global instance
        agent_memory_server.memory_vector_db_factory._memory_vector_db = None

    @pytest.mark.asyncio
    async def test_factory_supports_custom_factory(self):
        """Test that the factory supports custom MemoryVectorDatabase implementations."""
        import agent_memory_server.memory_vector_db_factory

        agent_memory_server.memory_vector_db_factory._memory_vector_db = None

        class CustomMemoryVectorDatabase(MemoryVectorDatabase):
            def __init__(self):
                pass

            async def add_memories(self, memories):
                return []

            async def search_memories(self, query, **kwargs):
                return MemoryRecordResults(memories=[], total=0, next_offset=None)

            async def count_memories(self, **kwargs):
                return 0

            async def delete_memories(self, memory_ids):
                return 0

            async def update_memories(self, memories):
                return 0

            async def list_memories(self, **kwargs):
                return MemoryRecordResults(memories=[], total=0, next_offset=None)

        with (
            patch(
                "agent_memory_server.memory_vector_db_factory.create_embeddings"
            ) as mock_create_embeddings,
            patch(
                "agent_memory_server.memory_vector_db_factory._import_and_call_factory"
            ) as mock_import_factory,
        ):
            mock_embeddings = MockEmbeddings()
            mock_create_embeddings.return_value = mock_embeddings

            custom_db = CustomMemoryVectorDatabase()
            mock_import_factory.return_value = custom_db

            db = create_memory_vector_db()

            assert db == custom_db

        agent_memory_server.memory_vector_db_factory._memory_vector_db = None

    def test_redis_adapter_preserves_discrete_memory_extracted_flag(self):
        """Regression test: Ensure data_to_memory_result preserves discrete_memory_extracted='t'."""
        mock_index = MagicMock()
        mock_embeddings = MockEmbeddings()

        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        # Simulate fields from a Redis search result
        from datetime import UTC, datetime

        fields = {
            "id_": "memory_001",
            "text": "User likes green tea",
            "session_id": "",
            "user_id": "",
            "namespace": "user_preferences",
            "created_at": str(datetime.now(UTC).timestamp()),
            "updated_at": str(datetime.now(UTC).timestamp()),
            "last_accessed": str(datetime.now(UTC).timestamp()),
            "topics": "preferences,beverages",
            "entities": "",
            "memory_hash": "abc123",
            "discrete_memory_extracted": "t",  # This should be preserved!
            "memory_type": "semantic",
            "persisted_at": None,
            "extracted_from": "",
            "event_date": None,
        }

        result = db._data_to_memory_result(fields, score=0.1)

        # REGRESSION TEST: This should be 't', not 'f'
        assert result.discrete_memory_extracted == "t", (
            f"Regression: Expected discrete_memory_extracted='t', got '{result.discrete_memory_extracted}'. "
            f"This indicates the adapter is not preserving the flag."
        )

        assert result.memory_type == "semantic"
        assert result.namespace == "user_preferences"
        assert result.text == "User likes green tea"

    def test_data_to_memory_result_decodes_legacy_pipe_delimited_tags(self):
        """Regression test: legacy pipe-delimited TAG values must hydrate as lists."""
        mock_index = MagicMock()
        mock_embeddings = MockEmbeddings()
        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        fields = {
            "id_": "memory_002",
            "text": "User likes Italian cooking",
            "session_id": "session-123",
            "user_id": "user-123",
            "namespace": "prefs",
            "topics": "cooking|italian",
            "entities": "pasta|rome",
            "memory_hash": "hash-123",
            "memory_type": "semantic",
            "created_at": "1704067200",
            "last_accessed": "1704067200",
            "updated_at": "1704067200",
            "discrete_memory_extracted": "t",
        }

        result = db._data_to_memory_result(fields, score=0.1)

        assert result.topics == ["cooking", "italian"]
        assert result.entities == ["pasta", "rome"]

    def test_normalize_rank_scores_zero_scores_remain_zero(self):
        """Zero-score batches should not be normalized into perfect matches."""
        mock_index = MagicMock()
        mock_embeddings = MockEmbeddings()
        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        assert db._normalize_rank_scores([0.0, 0.0]) == [0.0, 0.0]

    @pytest.mark.asyncio
    async def test_list_memories_does_not_overwrite_dist_with_score(self):
        """Filter-only listings should keep neutral distance semantics."""
        mock_index = MagicMock()
        mock_index.exists = AsyncMock(return_value=True)
        mock_index.info = AsyncMock(
            return_value={
                "attributes": [{"attribute": "project_id"}, {"attribute": "agent_id"}]
            }
        )
        mock_index.query = AsyncMock(
            return_value=[
                {
                    "id_": "memory_003",
                    "text": "User prefers tea",
                    "memory_type": "semantic",
                    "created_at": "1704067200",
                    "last_accessed": "1704067200",
                    "updated_at": "1704067200",
                    "discrete_memory_extracted": "t",
                }
            ]
        )
        mock_embeddings = MockEmbeddings()

        db = RedisVLMemoryVectorDatabase(mock_index, mock_embeddings)

        results = await db.list_memories(limit=10)

        assert results.total == 1
        assert results.memories[0].dist == 0.0
        assert results.memories[0].score is None

    def test_build_redis_schema_explicit_tag_separators(self):
        """Regression test: list-backed TAG fields must explicitly use comma separators."""
        schema = _build_redis_schema()
        field_map = {field["name"]: field for field in schema["fields"]}

        assert field_map["topics"]["attrs"]["separator"] == ","
        assert field_map["entities"]["attrs"]["separator"] == ","
        assert field_map["extracted_from"]["attrs"]["separator"] == ","


class TestCreateEmbeddings:
    """Test cases for the create_embeddings function.

    Note: The embedding creation logic is now in LLMClient.create_embeddings(),
    which returns LiteLLMEmbeddings for all providers.
    """

    def test_create_embeddings_returns_litellm_embeddings(self):
        """Test that create_embeddings returns LiteLLMEmbeddings."""
        from agent_memory_server.config import ModelProvider
        from agent_memory_server.llm.embeddings import LiteLLMEmbeddings

        mock_model_config = MagicMock()
        mock_model_config.provider = ModelProvider.OPENAI
        mock_model_config.embedding_dimensions = 1536

        with patch("agent_memory_server.config.settings") as mock_settings:
            mock_settings.embedding_model_config = mock_model_config
            mock_settings.embedding_model = "text-embedding-3-small"
            mock_settings.openai_api_key = "test-key"
            mock_settings.openai_api_base = None

            result = create_embeddings()

            assert isinstance(result, LiteLLMEmbeddings)
            assert result.model == "text-embedding-3-small"

    def test_create_embeddings_aws_bedrock_adds_prefix(self):
        """Test that Bedrock models get bedrock/ prefix added."""
        import warnings

        from agent_memory_server.config import ModelProvider
        from agent_memory_server.llm.embeddings import LiteLLMEmbeddings

        mock_model_config = MagicMock()
        mock_model_config.provider = ModelProvider.AWS_BEDROCK
        mock_model_config.embedding_dimensions = 1024

        with patch("agent_memory_server.config.settings") as mock_settings:
            mock_settings.embedding_model_config = mock_model_config
            mock_settings.embedding_model = "amazon.titan-embed-text-v2:0"
            mock_settings.openai_api_key = None
            mock_settings.openai_api_base = None

            with warnings.catch_warnings(record=True) as w:
                warnings.simplefilter("always")
                result = create_embeddings()

                # Should emit deprecation warning for unprefixed model
                matching_warnings = [
                    warning
                    for warning in w
                    if issubclass(warning.category, DeprecationWarning)
                    and "should use 'bedrock/' prefix" in str(warning.message)
                ]
                assert len(matching_warnings) == 1

            assert isinstance(result, LiteLLMEmbeddings)
            assert result.model == "bedrock/amazon.titan-embed-text-v2:0"

    def test_create_embeddings_anthropic_raises_error(self):
        """Test that Anthropic provider raises error (no embedding models)."""
        from agent_memory_server.config import ModelProvider
        from agent_memory_server.llm.exceptions import ModelValidationError

        mock_model_config = MagicMock()
        mock_model_config.provider = ModelProvider.ANTHROPIC

        with patch("agent_memory_server.config.settings") as mock_settings:
            mock_settings.embedding_model_config = mock_model_config
            mock_settings.embedding_model = "claude-embedding"

            with pytest.raises(
                ModelValidationError, match="Anthropic does not provide embedding"
            ):
                create_embeddings()
