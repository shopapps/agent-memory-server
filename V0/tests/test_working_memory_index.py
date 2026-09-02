from unittest.mock import AsyncMock, Mock, patch

import pytest

from agent_memory_server.working_memory_index import ensure_working_memory_index


@pytest.mark.asyncio
async def test_existing_working_memory_index_is_rebuilt_for_v1_scope_fields():
    index = Mock()
    index.exists = AsyncMock(return_value=True)
    index.create = AsyncMock()
    redis = Mock()
    redis.ft.return_value.info = AsyncMock(
        return_value={
            "attributes": [["identifier", "$.session_id", "attribute", "session_id"]]
        }
    )

    with patch(
        "agent_memory_server.working_memory_index.get_working_memory_index",
        new=AsyncMock(return_value=index),
    ):
        changed = await ensure_working_memory_index(redis)

    assert changed is True
    index.create.assert_awaited_once_with(overwrite=True, drop=False)


@pytest.mark.asyncio
async def test_existing_v1_working_memory_index_is_left_alone():
    index = Mock()
    index.exists = AsyncMock(return_value=True)
    index.create = AsyncMock()
    redis = Mock()
    redis.ft.return_value.info = AsyncMock(
        return_value={
            "attributes": [
                ["identifier", "$.project_id", "attribute", "project_id"],
                ["identifier", "$.agent_id", "attribute", "agent_id"],
            ]
        }
    )

    with patch(
        "agent_memory_server.working_memory_index.get_working_memory_index",
        new=AsyncMock(return_value=index),
    ):
        changed = await ensure_working_memory_index(redis)

    assert changed is False
    index.create.assert_not_awaited()


@pytest.mark.asyncio
async def test_concurrent_working_index_upgrade_accepts_other_process_success():
    index = Mock()
    index.exists = AsyncMock(return_value=True)
    index.create = AsyncMock(side_effect=RuntimeError("index changed"))
    redis = Mock()
    redis.ft.return_value.info = AsyncMock(
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

    with patch(
        "agent_memory_server.working_memory_index.get_working_memory_index",
        new=AsyncMock(return_value=index),
    ):
        changed = await ensure_working_memory_index(redis)

    assert changed is False
