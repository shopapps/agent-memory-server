from unittest.mock import AsyncMock

import pytest

from agent_memory_server.migrations import (
    SHARED_SCOPE_VALUE,
    migrate_add_discrete_memory_extracted_2,
    migrate_add_memory_hashes_1,
    migrate_add_scope_fields_5,
    migrate_normalize_tag_separators_4,
)
from agent_memory_server.utils.recency import generate_memory_hash_from_fields


def v1_hash(
    text,
    *,
    project_id=None,
    user_id=None,
    agent_id=None,
    session_id=None,
    namespace=None,
    memory_type="message",
):
    return generate_memory_hash_from_fields(
        text=text,
        project_id=project_id,
        user_id=user_id,
        agent_id=agent_id,
        session_id=session_id,
        namespace=namespace,
        memory_type=memory_type,
    )


class FakePipeline:
    def __init__(self, execute_result):
        self.execute_result = execute_result
        self.hgetall_calls = []
        self.hset_calls = []

    def hgetall(self, key):
        self.hgetall_calls.append(key)
        return self

    def hset(self, key, field=None, value=None, *, mapping=None):
        update = mapping if mapping is not None else {field: value}
        self.hset_calls.append((key, update))
        return self

    async def execute(self):
        return self.execute_result


class FakeRedis:
    def __init__(self, scan_results, read_results):
        self.scan_results = iter(scan_results)
        self.read_results = iter(read_results)
        self.pipeline_transactions = []
        self.pipelines = []
        self.eval_calls = []

    async def scan(self, cursor=0, match=None, count=100):
        return next(self.scan_results)

    def pipeline(self, transaction=True):
        self.pipeline_transactions.append(transaction)
        execute_result = next(self.read_results, [])
        pipe = FakePipeline(execute_result)
        self.pipelines.append(pipe)
        return pipe

    async def eval(self, script, number_of_keys, key, *args):
        self.eval_calls.append((script, number_of_keys, key, args))
        return 1


def scope_eval_updates(eval_call):
    args = eval_call[3]
    expected_arg_count = 16
    update_count = int(args[expected_arg_count])
    update_args = args[expected_arg_count + 1 :]
    return {
        update_args[index]: update_args[index + 1]
        for index in range(0, update_count * 2, 2)
    }


class TestMigrations:
    @pytest.mark.asyncio
    async def test_migrate_add_memory_hashes_handles_hashless_legacy_record(self):
        key = "memory_idx:test-memory"
        redis = FakeRedis(
            scan_results=[(0, [key])],
            read_results=[
                [{b"text": b"legacy memory", b"user_id": b"user-1"}],
                [],
            ],
        )

        await migrate_add_memory_hashes_1(redis=redis)

        assert redis.pipelines[1].hset_calls == [
            (
                key,
                {
                    "memory_hash": v1_hash(
                        "legacy memory",
                        user_id="user-1",
                    )
                },
            )
        ]

    @pytest.mark.asyncio
    async def test_migrate_discrete_flag_preserves_existing_true_value(self):
        redis = FakeRedis(scan_results=[], read_results=[])
        redis.keys = AsyncMock(return_value=["memory_idx:test-memory"])
        redis.hget = AsyncMock(side_effect=[b"memory-1", b"t"])
        redis.hset = AsyncMock()

        await migrate_add_discrete_memory_extracted_2(redis=redis)

        redis.hset.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_migrate_normalize_tag_separators_rewrites_legacy_values(self):
        key = "memory_idx:test-memory"
        redis = FakeRedis(
            scan_results=[(0, [key])],
            read_results=[
                [
                    {
                        b"topics": b"cooking|italian",
                        b"entities": b"pasta|rome",
                        b"extracted_from": b"msg-1|msg-2",
                    }
                ],
                [],
            ],
        )

        await migrate_normalize_tag_separators_4(redis=redis)

        assert redis.pipeline_transactions == [False, False]
        read_pipe, write_pipe = redis.pipelines
        assert read_pipe.hgetall_calls == [key]
        assert write_pipe.hset_calls == [
            (
                key,
                {
                    "topics": "cooking,italian",
                    "entities": "pasta,rome",
                    "extracted_from": "msg-1,msg-2",
                },
            )
        ]

    @pytest.mark.asyncio
    async def test_migrate_normalize_tag_separators_skips_canonical_values(self):
        key = "memory_idx:test-memory"
        redis = FakeRedis(
            scan_results=[(0, [key])],
            read_results=[
                [
                    {
                        b"topics": b"cooking,italian",
                        b"entities": b"pasta,rome",
                        b"extracted_from": b"msg-1,msg-2",
                    }
                ],
                [],
            ],
        )

        await migrate_normalize_tag_separators_4(redis=redis)

        assert redis.pipeline_transactions == [False, False]
        read_pipe, write_pipe = redis.pipelines
        assert read_pipe.hgetall_calls == [key]
        assert write_pipe.hset_calls == []

    @pytest.mark.asyncio
    async def test_migrate_add_scope_fields_adds_shared_values_to_legacy_memory(self):
        key = "memory_idx:test-memory"
        redis = FakeRedis(
            scan_results=[(0, [key])],
            read_results=[
                [{b"text": b"legacy memory"}],
                [],
            ],
        )

        await migrate_add_scope_fields_5(redis=redis)

        assert redis.pipeline_transactions == [False]
        read_pipe = redis.pipelines[0]
        assert read_pipe.hgetall_calls == [key]
        assert scope_eval_updates(redis.eval_calls[0]) == {
            "project_id": SHARED_SCOPE_VALUE,
            "user_id": SHARED_SCOPE_VALUE,
            "agent_id": SHARED_SCOPE_VALUE,
            "session_id": SHARED_SCOPE_VALUE,
            "memory_hash": v1_hash("legacy memory"),
        }

    @pytest.mark.asyncio
    async def test_migrate_add_scope_fields_preserves_existing_scope_values(self):
        key = "memory_idx:test-memory"
        redis = FakeRedis(
            scan_results=[(0, [key])],
            read_results=[
                [
                    {
                        b"project_id": b"project-1",
                        b"user_id": b"user-1",
                        b"agent_id": b"agent-1",
                        b"session_id": b"session-1",
                        b"text": b"private memory",
                    }
                ],
                [],
            ],
        )

        await migrate_add_scope_fields_5(redis=redis)

        assert redis.pipeline_transactions == [False]
        read_pipe = redis.pipelines[0]
        assert read_pipe.hgetall_calls == [key]
        assert scope_eval_updates(redis.eval_calls[0]) == {
            "memory_hash": v1_hash(
                "private memory",
                project_id="project-1",
                user_id="user-1",
                agent_id="agent-1",
                session_id="session-1",
            )
        }

    @pytest.mark.asyncio
    async def test_migrate_add_scope_fields_normalizes_missing_and_empty_scopes(self):
        key = "memory_idx:test-memory"
        redis = FakeRedis(
            scan_results=[(0, [key])],
            read_results=[
                [
                    {
                        "project_id": "project-1",
                        "user_id": "user-1",
                        "session_id": "",
                        "text": "partly scoped memory",
                    }
                ],
                [],
            ],
        )

        await migrate_add_scope_fields_5(redis=redis)

        read_pipe = redis.pipelines[0]
        assert read_pipe.hgetall_calls == [key]
        assert scope_eval_updates(redis.eval_calls[0]) == {
            "agent_id": SHARED_SCOPE_VALUE,
            "session_id": SHARED_SCOPE_VALUE,
            "memory_hash": v1_hash(
                "partly scoped memory",
                project_id="project-1",
                user_id="user-1",
            ),
        }
