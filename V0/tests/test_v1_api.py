from unittest.mock import AsyncMock, Mock, patch

import pytest

from agent_memory_server.api import search_long_term_memory
from agent_memory_server.models import (
    MemoryRecordResult,
    MemoryRecordResults,
    SearchRequest,
)


def memory(memory_id, text):
    return MemoryRecordResult(id=memory_id, text=text, dist=0.1)


@pytest.mark.asyncio
async def test_rest_search_packs_ranked_results_and_returns_budget_metadata(client):
    search = AsyncMock(
        return_value=MemoryRecordResults(
            memories=[
                memory("a", "first memory"),
                memory("b", "second memory"),
                memory("c", "third memory"),
            ],
            total=3,
        )
    )
    with (
        patch(
            "agent_memory_server.api.long_term_memory.search_long_term_memories",
            search,
        ),
        patch(
            "agent_memory_server.api._count_text_tokens",
            side_effect=lambda text: len(text.split()),
        ),
    ):
        response = await client.post(
            "/v1/long-term-memory/search",
            json={
                "text": "ranked",
                "max_tokens": 10,
                "max_results": 10,
                "recency_boost": False,
            },
        )

    assert response.status_code == 200
    data = response.json()
    assert [item["id"] for item in data["memories"]] == ["a", "b"]
    assert data["tokens_used"] == 10
    assert data["token_budget"] == 10
    assert data["budget_exhausted"] is True
    assert search.await_args.kwargs["limit"] == 40


@pytest.mark.asyncio
async def test_semantic_fallback_never_relaxes_namespace_or_private_scopes(client):
    search = AsyncMock(return_value=MemoryRecordResults(memories=[], total=0))
    with patch(
        "agent_memory_server.api.long_term_memory.search_long_term_memories", search
    ):
        response = await client.post(
            "/v1/long-term-memory/search",
            json={
                "text": "missing",
                "namespace": {"eq": "coding/umony/archive"},
                "project_id": {"eq": "project-a"},
                "user_id": {"eq": "user-a"},
                "agent_id": {"eq": "agent-a"},
                "session_id": {"eq": "session-a"},
                "topics": {"eq": "archive"},
                "recency_boost": False,
            },
        )

    assert response.status_code == 200
    assert search.await_count == 2
    fallback = search.await_args_list[1].kwargs
    assert fallback["namespace"].eq == "coding/umony/archive"
    assert fallback["project_id"].eq == "project-a"
    assert fallback["user_id"].eq == "user-a"
    assert fallback["agent_id"].eq == "agent-a"
    assert fallback["session_id"].eq == "session-a"


@pytest.mark.asyncio
async def test_memory_prompt_uses_the_same_packed_memories_and_budget_metadata(client):
    search = AsyncMock(
        return_value=MemoryRecordResults(
            memories=[
                memory("a", "first memory"),
                memory("b", "second memory"),
            ],
            total=2,
        )
    )
    with (
        patch(
            "agent_memory_server.api.long_term_memory.search_long_term_memories",
            search,
        ),
        patch(
            "agent_memory_server.api._count_text_tokens",
            side_effect=lambda text: len(text.split()),
        ),
    ):
        response = await client.post(
            "/v1/memory/prompt",
            json={
                "query": "What matters?",
                "long_term_search": {
                    "text": "replaced by query",
                    "max_tokens": 14,
                    "max_results": 10,
                    "recency_boost": False,
                },
            },
        )

    assert response.status_code == 200
    data = response.json()
    memory_message = data["messages"][0]["content"]["text"]
    assert "- first memory (ID: a)" in memory_message
    assert "second memory" not in memory_message
    assert [item["id"] for item in data["long_term_memories"]] == ["a"]
    assert len(memory_message.split()) == 14
    assert data["tokens_used"] == 14
    assert data["token_budget"] == 14
    assert data["budget_exhausted"] is True


@pytest.mark.asyncio
async def test_memory_prompt_handles_a_budget_too_small_for_any_memory(client):
    search = AsyncMock(
        return_value=MemoryRecordResults(
            memories=[memory("a", "first memory")],
            total=1,
        )
    )
    with (
        patch(
            "agent_memory_server.api.long_term_memory.search_long_term_memories",
            search,
        ),
        patch(
            "agent_memory_server.api._count_text_tokens",
            side_effect=lambda text: len(text.split()),
        ),
    ):
        response = await client.post(
            "/v1/memory/prompt",
            json={
                "query": "What matters?",
                "long_term_search": {
                    "max_tokens": 1,
                    "recency_boost": False,
                },
            },
        )

    assert response.status_code == 200
    data = response.json()
    assert data["long_term_memories"] == []
    assert all(
        "Long term memories" not in message["content"]["text"]
        for message in data["messages"]
    )
    assert data["tokens_used"] == 0
    assert data["budget_exhausted"] is True


@pytest.mark.asyncio
async def test_no_budget_memory_prompt_keeps_the_old_empty_memory_message(client):
    search = AsyncMock(return_value=MemoryRecordResults(memories=[], total=0))
    with patch(
        "agent_memory_server.api.long_term_memory.search_long_term_memories",
        search,
    ):
        response = await client.post(
            "/v1/memory/prompt",
            json={
                "query": "What matters?",
                "long_term_search": {"recency_boost": False},
            },
        )

    assert response.status_code == 200
    data = response.json()
    assert (
        "No relevant long-term memories found" in data["messages"][0]["content"]["text"]
    )
    assert "tokens_used" not in data
    assert "token_budget" not in data
    assert "budget_exhausted" not in data


@pytest.mark.asyncio
@pytest.mark.parametrize("server_side_recency", [False, True])
async def test_every_search_path_tracks_only_the_packed_memory_ids(
    server_side_recency,
):
    search = AsyncMock(
        return_value=MemoryRecordResults(
            memories=[
                memory("a", "first memory"),
                memory("b", "second memory"),
            ],
            total=2,
        )
    )
    background_tasks = Mock()
    request = SearchRequest(
        text="ranked",
        max_tokens=5,
        max_results=10,
        recency_boost=False,
        server_side_recency=server_side_recency,
    )

    with (
        patch(
            "agent_memory_server.api.long_term_memory.search_long_term_memories",
            search,
        ),
        patch(
            "agent_memory_server.api._count_text_tokens",
            side_effect=lambda text: len(text.split()),
        ),
    ):
        result = await search_long_term_memory(request, background_tasks)

    assert [item.id for item in result.memories] == ["a"]
    background_tasks.add_task.assert_called_once()
    assert background_tasks.add_task.call_args.args[1] == ["a"]


@pytest.mark.asyncio
async def test_boolean_memory_prompt_search_inherits_session_v1_scopes(client):
    prompt_search = AsyncMock(return_value=MemoryRecordResults(memories=[], total=0))
    with (
        patch("agent_memory_server.api.search_long_term_memory", prompt_search),
        patch(
            "agent_memory_server.api.working_memory.get_working_memory",
            new=AsyncMock(return_value=None),
        ),
    ):
        response = await client.post(
            "/v1/memory/prompt",
            json={
                "query": "What matters?",
                "session": {
                    "session_id": "session-a",
                    "project_id": "project-a",
                    "agent_id": "agent-a",
                },
                "long_term_search": True,
            },
        )

    assert response.status_code == 200
    search_request = prompt_search.await_args.args[0]
    assert search_request.session_id.eq == "session-a"
    assert search_request.project_id.eq == "project-a"
    assert search_request.user_id.eq == "__shared__"
    assert search_request.agent_id.eq == "agent-a"


@pytest.mark.asyncio
async def test_structured_memory_prompt_search_stays_in_the_current_session_scope(
    client,
):
    prompt_search = AsyncMock(return_value=MemoryRecordResults(memories=[], total=0))
    with (
        patch("agent_memory_server.api.search_long_term_memory", prompt_search),
        patch(
            "agent_memory_server.api.working_memory.get_working_memory",
            new=AsyncMock(return_value=None),
        ),
    ):
        response = await client.post(
            "/v1/memory/prompt",
            json={
                "query": "What matters?",
                "session": {
                    "session_id": "session-a",
                    "project_id": "project-a",
                    "user_id": "user-a",
                    "agent_id": "agent-a",
                },
                "long_term_search": {
                    "session_id": {"eq": "session-b"},
                    "project_id": {"eq": "project-b"},
                    "include_shared": True,
                },
            },
        )

    assert response.status_code == 200
    search_request = prompt_search.await_args.args[0]
    filters = search_request.get_filters()
    assert filters["session_id"].any == ["session-a", "__shared__"]
    assert filters["project_id"].any == ["project-a", "__shared__"]
    assert filters["user_id"].any == ["user-a", "__shared__"]
    assert filters["agent_id"].any == ["agent-a", "__shared__"]


@pytest.mark.asyncio
async def test_no_budget_search_keeps_the_old_rest_shape(client):
    search = AsyncMock(
        return_value=MemoryRecordResults(
            memories=[memory("a", "first memory")],
            total=1,
        )
    )
    with patch(
        "agent_memory_server.api.long_term_memory.search_long_term_memories",
        search,
    ):
        response = await client.post(
            "/v1/long-term-memory/search",
            json={"text": "ranked", "recency_boost": False},
        )

    assert response.status_code == 200
    assert "tokens_used" not in response.json()
    assert "token_budget" not in response.json()
    assert "budget_exhausted" not in response.json()
