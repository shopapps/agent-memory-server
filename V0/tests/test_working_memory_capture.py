"""Capture uses disposable test Redis, never the developer's memory database."""

import asyncio
import json
from datetime import timedelta
from html import escape
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4

import pytest
from docket import Docket, Worker
from docket.dependencies import Retry
from fastapi import FastAPI, HTTPException, Request
from httpx import ASGITransport, AsyncClient

from agent_memory_server import working_memory_capture as capture
from agent_memory_server.auth import UserInfo, get_current_user
from agent_memory_server.config import settings
from agent_memory_server.models import MemoryRecordResult, MemoryRecordResults


TEST_SESSION = ""


@pytest.fixture(autouse=True)
def isolated_capture(monkeypatch, requires_redis):
    global TEST_SESSION
    TEST_SESSION = str(uuid4())
    monkeypatch.setattr(
        capture, "get_redis_conn", AsyncMock(return_value=requires_redis)
    )
    # Tests explicitly drain continuations; never schedule into the live worker queue.
    monkeypatch.setattr(capture.HybridBackgroundTasks, "add_task", Mock())
    monkeypatch.setattr(settings, "working_memory_daily_filter_token_limit", 0)
    monkeypatch.setattr(settings, "working_memory_handoff_enabled", False)


def event(
    role="user", text="This project uses Redis for session storage.", turn="1", **kwargs
):
    return capture.CaptureEvent(
        session_id=TEST_SESSION,
        user_id=f"local-user-{TEST_SESSION}",
        project_id="example/shop",
        client="codex",
        turn_id=turn,
        role=role,
        content=text,
        **kwargs,
    )


def scope():
    return capture.CaptureScope(**event().model_dump())


async def exchange(redis, turn="1", **kwargs):
    await capture.capture_event(event(turn=turn, **kwargs), redis)
    return await capture.capture_event(
        event(
            "assistant",
            "Confirmed: this project uses Redis for session storage.",
            turn,
            **kwargs,
        ),
        redis,
    )


def model_result(memory, **overrides):
    message = next(m for m in memory.messages if m.role == "user")
    return SimpleNamespace(
        prompt_tokens=40,
        completion_tokens=10,
        total_tokens=50,
        content=json.dumps(
            {
                "candidates": [
                    {
                        "text": "example/shop uses Redis for session storage.",
                        "category": "architecture",
                        "evidence": message.content,
                        "message_id": message.id,
                        "confidence": 0.95,
                        **overrides,
                    }
                ]
            }
        ),
    )


@pytest.mark.asyncio
async def test_capture_bounds_pairs_and_retry_is_idempotent(requires_redis):
    redis = requires_redis
    for i in range(35):
        await exchange(redis, str(i))
    memory = await capture.load_capture(redis, scope())
    assert len(memory.messages) == 60
    assert memory.memories == []
    await redis.expire(scope().key(), 123)
    await exchange(redis, "34")
    assert await redis.ttl(scope().key()) <= 123
    assert len((await capture.load_capture(redis, scope())).messages) == 60
    assert memory.messages[0].content.startswith("This project")


@pytest.mark.asyncio
async def test_capture_limits_content_and_total_storage(requires_redis):
    for i in range(30):
        await capture.capture_event(event(text="x" * 9000, turn=str(i)), requires_redis)
    memory = await capture.load_capture(requires_redis, scope())
    assert max(len(m.content) for m in memory.messages) <= capture.MAX_MESSAGE_CHARS
    assert sum(len(m.content) for m in memory.messages) <= capture.MAX_SESSION_CHARS


@pytest.mark.asyncio
async def test_concurrent_capture_does_not_lose_messages(requires_redis):
    await asyncio.gather(
        *(capture.capture_event(event(turn=str(i)), requires_redis) for i in range(15))
    )
    assert len((await capture.load_capture(requires_redis, scope())).messages) == 15


@pytest.mark.parametrize(
    "text",
    [
        "<private>Do not store this</private>",
        "api_key=example-secret",
        "Bearer sample-secret",
        capture.PRIVATE,
    ],
)
@pytest.mark.asyncio
async def test_private_exchange_never_reaches_filter(requires_redis, text):
    await capture.capture_event(event(text=text), requires_redis)
    await capture.capture_event(
        event("assistant", "An otherwise harmless reply"), requires_redis
    )
    memory = await capture.load_capture(requires_redis, scope())
    assert all(m.content == capture.PRIVATE for m in memory.messages)
    with patch.object(
        capture.LLMClient, "create_chat_completion", new_callable=AsyncMock
    ) as model:
        await capture.process_capture(scope().model_dump())
    model.assert_not_awaited()


@pytest.mark.asyncio
async def test_expired_capture_is_not_reconstructed(requires_redis, monkeypatch):
    await exchange(requires_redis)
    await requires_redis.pexpire(scope().key(), 1)
    await asyncio.sleep(0.02)
    monkeypatch.setattr(settings, "index_all_messages_in_long_term_memory", True)
    assert await capture.load_capture(requires_redis, scope()) is None


@pytest.mark.asyncio
async def test_recall_scope_and_reads_do_not_extend_ttl(requires_redis):
    await exchange(requires_redis)
    for changes in [{"project_id": "example/other"}, {"user_id": "other-user"}]:
        other = event().model_copy(update=changes)
        await capture.capture_event(other, requires_redis)
    await requires_redis.expire(scope().key(), 123)
    memories = await capture.capture_sessions(
        requires_redis, scope().user_id, "example/shop"
    )
    assert len(memories) == 1
    assert await requires_redis.ttl(scope().key()) <= 123


@pytest.mark.asyncio
async def test_review_filters_without_promoting_and_retry_does_not_repeat_model(
    requires_redis,
):
    memory = await exchange(requires_redis)
    with (
        patch.object(
            capture.LLMClient,
            "create_chat_completion",
            new_callable=AsyncMock,
            return_value=model_result(memory),
        ) as model,
        patch.object(
            capture, "index_long_term_memories", new_callable=AsyncMock
        ) as index,
    ):
        await capture.process_capture(scope().model_dump())
        await capture.process_capture(scope().model_dump())
    model.assert_awaited_once()
    index.assert_not_awaited()
    state = (await capture.load_capture(requires_redis, scope())).data["capture"]
    assert len(state["candidates"]) == 1
    assert state["candidates"][0]["status"] == "pending"


@pytest.mark.parametrize(
    "overrides",
    [
        {"confidence": 0.2},
        {"evidence": "This never appeared in the chat."},
        {"text": "password=not-safe-to-store"},
        {"message_id": "wrong-project"},
    ],
)
@pytest.mark.asyncio
async def test_filter_rejects_unsupported_or_sensitive_candidates(
    requires_redis, overrides
):
    memory = await exchange(requires_redis)
    with patch.object(
        capture.LLMClient,
        "create_chat_completion",
        new_callable=AsyncMock,
        return_value=model_result(memory, **overrides),
    ):
        await capture.process_capture(scope().model_dump())
    assert (await capture.load_capture(requires_redis, scope())).data["capture"][
        "candidates"
    ] == []


@pytest.mark.asyncio
async def test_auto_promotion_saves_only_fact_and_shared_project_scope(
    requires_redis, monkeypatch
):
    monkeypatch.setattr(settings, "long_term_memory", True)
    memory = await exchange(requires_redis, promotion="auto")
    with (
        patch.object(
            capture.LLMClient,
            "create_chat_completion",
            new_callable=AsyncMock,
            return_value=model_result(memory),
        ),
        patch.object(
            capture, "index_long_term_memories", new_callable=AsyncMock
        ) as index,
    ):
        await capture.process_capture(scope().model_dump())
        await capture.process_capture(scope().model_dump())
    index.assert_awaited_once()
    saved = index.call_args.args[0][0]
    assert saved.project_id == "example/shop"
    assert saved.namespace == "example/shop"
    assert saved.user_id is saved.agent_id is saved.session_id is None
    assert saved.discrete_memory_extracted == "t"
    assert saved.text == "example/shop uses Redis for session storage."
    assert (await capture.load_capture(requires_redis, scope())).data["capture"][
        "candidates"
    ][0]["status"] == "promoted"


@pytest.mark.asyncio
async def test_model_failure_keeps_messages_retryable_without_raw_error(requires_redis):
    await exchange(requires_redis)
    with (
        patch.object(
            capture.LLMClient,
            "create_chat_completion",
            new_callable=AsyncMock,
            side_effect=ValueError("private provider data"),
        ),
        pytest.raises(RuntimeError, match="processing failed"),
    ):
        await capture.process_capture(scope().model_dump())
    memory = await capture.load_capture(requires_redis, scope())
    assert len(memory.messages) == 2
    assert memory.data["capture"]["processed"] == []
    assert "private provider data" not in json.dumps(memory.data)


@pytest.mark.asyncio
async def test_capture_api_requires_auth_and_validates_event(
    requires_redis, monkeypatch
):
    app = FastAPI()
    app.include_router(capture.router)
    monkeypatch.setattr(settings, "disable_auth", False)
    monkeypatch.setattr(settings, "auth_mode", "token")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        page = await client.get("/admin/working-memory?user_id=local-user")
        assert page.status_code == 200
        assert page.headers["Cache-Control"] == "no-store"
        assert 'id="graph-link"' in page.text
        assert 'aria-describedby="user-help"' in page.text
        assert 'aria-describedby="token-help"' in page.text
        assert "It is a label, not a password or access check." in page.text
        assert "Leave it blank for the default local setup." in page.text
        assert "It is not your OpenAI API key." in page.text
        assert "This page does not save it or put it in links." in page.text
        assert (
            await client.get("/v1/working-memory-capture/sessions?user_id=local-user")
        ).status_code in (401, 403)
        app.dependency_overrides[get_current_user] = lambda: UserInfo(sub="test")
        response = await client.post(
            "/v1/working-memory-capture/events",
            json=event(promotion="off").model_dump(),
        )
        assert response.status_code == 200
        invalid = event().model_dump()
        invalid["project_id"] = ""
        assert (
            await client.post("/v1/working-memory-capture/events", json=invalid)
        ).status_code == 422
        response = await client.post(
            "/v1/working-memory-capture/session", json=scope().model_dump()
        )
        assert response.status_code == 200
        assert response.json()["expires_in_seconds"] > 0
        assert response.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize(
    ("hostname", "auth_mode", "expected"),
    [
        ("127.0.0.1", "disabled", True),
        ("localhost", "disabled", True),
        ("[::1]", "disabled", True),
        ("memory.example.com", "disabled", False),
        ("127.0.0.1", "token", False),
        ("127.0.0.1", "oauth2", False),
    ],
)
@pytest.mark.asyncio
async def test_review_page_prefills_only_local_auth_disabled_runtime(
    monkeypatch, hostname, auth_mode, expected
):
    user_id = 'local-user"<example>&'
    monkeypatch.setattr(settings, "disable_auth", False)
    monkeypatch.setattr(settings, "auth_mode", auth_mode)
    monkeypatch.setattr(settings, "working_memory_local_user_id", user_id)
    app = FastAPI()
    app.include_router(capture.router)
    async with AsyncClient(
        transport=ASGITransport(app=app, client=("192.168.65.1", 1234)),
        base_url=f"http://{hostname}:8000",
    ) as client:
        response = await client.get("/admin/working-memory")
    assert response.status_code == 200
    value = escape(user_id, quote=True) if expected else ""
    assert f'id="user" value="{value}"' in response.text
    assert user_id not in response.text
    assert response.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize(
    ("codex", "claude", "peer", "port", "expected"),
    [
        ("same-user", None, "127.0.0.1", 8000, "same-user"),
        (None, "same-user", "::1", 8000, "same-user"),
        ("same-user", "same-user", "127.0.0.1", 8000, "same-user"),
        ("first-user", "second-user", "127.0.0.1", 8000, ""),
        (None, None, "127.0.0.1", 8000, ""),
        ("same-user", None, "192.168.1.2", 8000, ""),
        ("same-user", None, "127.0.0.1", 8010, ""),
        ("malformed-json", None, "127.0.0.1", 8000, ""),
        ("bad,id", None, "127.0.0.1", 8000, ""),
    ],
)
@pytest.mark.asyncio
async def test_native_review_reads_only_matching_local_settings(
    tmp_path, monkeypatch, codex, claude, peer, port, expected
):
    monkeypatch.setattr(settings, "disable_auth", True)
    monkeypatch.setattr(settings, "working_memory_local_user_id", None)
    for variable, user_id in (("CODEX_HOME", codex), ("CLAUDE_CONFIG_DIR", claude)):
        directory = tmp_path / variable
        directory.mkdir()
        monkeypatch.setenv(variable, str(directory))
        if user_id:
            content = (
                "not-json"
                if user_id == "malformed-json"
                else json.dumps(
                    {
                        "owner": "@shopapps/agent-memory/working-memory",
                        "apiUrl": f"http://localhost:{port}",
                        "userId": user_id,
                    }
                )
            )
            (directory / "ams-working-memory.json").write_text(content)
    request = Request(
        {
            "type": "http",
            "scheme": "http",
            "server": ("127.0.0.1", 8000),
            "path": "/admin/working-memory",
            "headers": [],
            "client": (peer, 1234),
        }
    )
    response = await capture.working_memory_page(request)
    assert f'id="user" value="{expected}"' in response.body.decode()


@pytest.mark.asyncio
async def test_slow_filter_keeps_new_messages_and_does_not_extend_expiry(
    requires_redis,
):
    memory = await exchange(requires_redis)

    async def model(**_kwargs):
        await capture.capture_event(
            event(turn="2", text="A new prompt while filtering runs."), requires_redis
        )
        await requires_redis.expire(scope().key(), 123)
        return model_result(memory)

    with patch.object(capture.LLMClient, "create_chat_completion", side_effect=model):
        await capture.process_capture(scope().model_dump())
    current = await capture.load_capture(requires_redis, scope())
    assert len(current.messages) == 3
    assert len(current.data["capture"]["processed"]) == 2
    assert await requires_redis.ttl(scope().key()) <= 123


@pytest.mark.asyncio
async def test_filter_never_restores_an_expired_session(requires_redis):
    memory = await exchange(requires_redis)

    async def model(**_kwargs):
        await requires_redis.pexpire(scope().key(), 1)
        await asyncio.sleep(0.02)
        return model_result(memory)

    with (
        patch.object(capture.LLMClient, "create_chat_completion", side_effect=model),
        patch.object(
            capture, "index_long_term_memories", new_callable=AsyncMock
        ) as index,
    ):
        await capture.process_capture(scope().model_dump())
    assert await capture.load_capture(requires_redis, scope()) is None
    index.assert_not_awaited()


@pytest.mark.asyncio
async def test_slow_promotion_preserves_new_capture_and_dismiss_is_final(
    requires_redis, monkeypatch
):
    monkeypatch.setattr(settings, "long_term_memory", True)
    memory = await exchange(requires_redis)
    with patch.object(
        capture.LLMClient,
        "create_chat_completion",
        new_callable=AsyncMock,
        return_value=model_result(memory),
    ):
        await capture.process_capture(scope().model_dump())
    current = await capture.load_capture(requires_redis, scope())
    candidate_id = current.data["capture"]["candidates"][0]["id"]

    async def index(*_args, **_kwargs):
        await capture.capture_event(event(turn="2"), requires_redis)

    decision = capture.CandidateDecision(
        **scope().model_dump(), candidate_id=candidate_id, action="promote"
    )
    with patch.object(capture, "index_long_term_memories", side_effect=index) as saved:
        await capture.decide_candidate(decision, requires_redis)
        await capture.decide_candidate(decision, requires_redis)
    saved.assert_awaited_once()
    assert len((await capture.load_capture(requires_redis, scope())).messages) == 3


@pytest.mark.asyncio
async def test_promotion_failure_can_retry_without_reextracting(
    requires_redis, monkeypatch
):
    monkeypatch.setattr(settings, "long_term_memory", True)
    memory = await exchange(requires_redis, promotion="auto")
    with (
        patch.object(
            capture.LLMClient,
            "create_chat_completion",
            new_callable=AsyncMock,
            return_value=model_result(memory),
        ) as model,
        patch.object(
            capture,
            "index_long_term_memories",
            new_callable=AsyncMock,
            side_effect=[ValueError("provider down"), None],
        ) as index,
    ):
        with pytest.raises(RuntimeError):
            await capture.process_capture(scope().model_dump())
        await capture.process_capture(scope().model_dump())
    model.assert_awaited_once()
    assert index.await_count == 2
    state = (await capture.load_capture(requires_redis, scope())).data["capture"]
    assert state["candidates"][0]["status"] == "promoted"
    assert state["status"] == "ready"


@pytest.mark.asyncio
async def test_recall_is_bounded_valid_json(requires_redis):
    for i in range(3):
        for turn in range(3):
            for role in ("user", "assistant"):
                item = event(role=role, turn=str(turn), text="A project note. " * 100)
                item.session_id = f"{TEST_SESSION}-{i}"
                await capture.capture_event(item, requires_redis)
    result = await capture.recall_endpoint(
        user_id=scope().user_id, project_id=scope().project_id
    )
    assert 0 < len(result["context"]) <= 12000
    assert json.loads(result["context"])


@pytest.mark.asyncio
async def test_permanent_recall_survives_chat_expiry_and_keeps_exact_scopes(
    requires_redis, monkeypatch
):
    monkeypatch.setattr(settings, "long_term_memory", True)
    records = [
        MemoryRecordResult(
            id="correct",
            text="Example shop uses Copper Finch.",
            project_id=scope().project_id,
            dist=0,
        ),
        MemoryRecordResult(
            id="wrong-project",
            text="Other shop fact.",
            project_id="other/project",
            dist=0,
        ),
        MemoryRecordResult(
            id="wrong-user",
            text="Other user's fact.",
            project_id=scope().project_id,
            user_id="someone-else",
            dist=0,
        ),
        MemoryRecordResult(
            id="agent-private",
            text="Agent private fact.",
            project_id=scope().project_id,
            agent_id="claude",
            dist=0,
        ),
        MemoryRecordResult(
            id="session-private",
            text="Session private fact.",
            project_id=scope().project_id,
            session_id="old-session",
            dist=0,
        ),
    ]
    search = AsyncMock(return_value=MemoryRecordResults(memories=records, total=5))
    with patch.object(capture, "search_long_term_memories", search):
        result = await capture.recall_endpoint(
            user_id=scope().user_id,
            project_id=scope().project_id,
            include_long_term=True,
            query="customer name",
        )
    assert result["context"] == ""
    assert result["memory_ids"] == ["correct"]
    assert json.loads(result["long_term_context"])[0]["text"] == records[0].text
    args = search.await_args.kwargs
    assert args["project_id"].eq == scope().project_id
    assert args["user_id"].any == [scope().user_id, capture.SHARED_SCOPE]
    assert args["agent_id"].eq == capture.SHARED_SCOPE
    assert args["session_id"].eq == capture.SHARED_SCOPE
    assert args["search_mode"] == capture.SearchModeEnum.KEYWORD


@pytest.mark.asyncio
async def test_recall_returns_whole_budgeted_facts_and_keeps_chat_on_search_failure(
    requires_redis, monkeypatch
):
    monkeypatch.setattr(settings, "long_term_memory", True)
    await exchange(requires_redis)
    await requires_redis.expire(scope().key(), 120)
    records = [
        MemoryRecordResult(
            id=str(i),
            text="Useful project fact. " * 60,
            project_id=scope().project_id,
            dist=0,
        )
        for i in range(10)
    ]
    with patch.object(
        capture,
        "search_long_term_memories",
        AsyncMock(return_value=MemoryRecordResults(memories=records, total=10)),
    ):
        result = await capture.recall_endpoint(
            user_id=scope().user_id,
            project_id=scope().project_id,
            include_long_term=True,
        )
    facts = json.loads(result["long_term_context"])
    assert 0 < len(facts) <= 6
    assert (
        len(
            capture.tiktoken.get_encoding("cl100k_base").encode(
                result["long_term_context"]
            )
        )
        <= 800
    )
    assert facts[0]["text"] == records[0].text
    assert await requires_redis.ttl(scope().key()) <= 120
    memory = await capture.load_capture(requires_redis, scope())
    assert memory.data["capture"]["last_recall_count"] == len(facts)
    with patch.object(
        capture,
        "search_long_term_memories",
        AsyncMock(side_effect=RuntimeError("secret error")),
    ):
        result = await capture.recall_endpoint(
            user_id=scope().user_id,
            project_id=scope().project_id,
            include_long_term=True,
        )
    assert result["context"]
    assert result["long_term_status"] == "unavailable"
    assert "secret error" not in json.dumps(result)


@pytest.mark.asyncio
async def test_private_prompt_never_reaches_permanent_search(requires_redis):
    with patch.object(
        capture, "search_long_term_memories", new_callable=AsyncMock
    ) as search:
        result = await capture.recall_prompt_endpoint(
            event(text="<private>private query</private>")
        )
    assert result["memory_ids"] == []
    search.assert_not_awaited()


@pytest.mark.asyncio
async def test_backlog_checks_one_exchange_then_queues_the_rest(requires_redis):
    for turn in range(4):
        await exchange(requires_redis, str(turn))
    with patch.object(
        capture.LLMClient,
        "create_chat_completion",
        new_callable=AsyncMock,
        return_value=SimpleNamespace(content='{"candidates": []}'),
    ) as model:
        for batch in range(4):
            await capture.process_capture(scope().model_dump())
            current = await capture.load_capture(requires_redis, scope())
            assert len(current.data["capture"]["processed"]) == (batch + 1) * 2
            assert (
                len(
                    json.loads(model.call_args.kwargs["messages"][1]["content"])[
                        "messages"
                    ]
                )
                == 2
            )
    assert capture.HybridBackgroundTasks.add_task.call_count == 3
    capture.HybridBackgroundTasks.add_task.assert_called_with(
        capture.process_capture, scope().model_dump()
    )
    assert current.data["capture"]["status"] == "ready"


@pytest.mark.asyncio
async def test_fourth_waiting_candidate_is_queued_and_saved_without_new_prompt(
    requires_redis, monkeypatch
):
    monkeypatch.setattr(settings, "long_term_memory", True)
    memory = await exchange(requires_redis)
    with patch.object(
        capture.LLMClient, "create_chat_completion", new_callable=AsyncMock
    ) as model:
        for i in range(4):
            model.return_value = model_result(
                memory, text=f"example/shop uses Redis database {i} for sessions."
            )
            # Different confirmed facts were held for review before switching to auto.
            await requires_redis.json().set(
                scope().key(), "$.data.capture.processed", []
            )
            await capture.process_capture(scope().model_dump())
    await capture.capture_event(
        event("assistant", memory.messages[-1].content, promotion="auto"),
        requires_redis,
    )
    with (
        patch.object(
            capture.LLMClient, "create_chat_completion", new_callable=AsyncMock
        ) as model,
        patch.object(
            capture, "index_long_term_memories", new_callable=AsyncMock
        ) as index,
    ):
        await capture.process_capture(scope().model_dump())
        current = await capture.load_capture(requires_redis, scope())
        assert capture.capture_activity(current)["counts"]["saved"] == 3
        assert current.data["capture"]["status"] == "pending"
        capture.HybridBackgroundTasks.add_task.assert_called_once_with(
            capture.process_capture, scope().model_dump()
        )
        # Execute the queued worker job, without another captured event.
        job = capture.HybridBackgroundTasks.add_task.call_args
        await job.args[0](*job.args[1:])
        await capture.process_capture(scope().model_dump())
    model.assert_not_awaited()
    assert index.await_count == 4
    current = await capture.load_capture(requires_redis, scope())
    assert current.data["capture"]["status"] == "ready"
    assert capture.capture_activity(current)["counts"]["saved"] == 4


@pytest.mark.asyncio
async def test_assistant_only_claim_needs_review_even_in_auto_mode(
    requires_redis, monkeypatch
):
    monkeypatch.setattr(settings, "long_term_memory", True)
    memory = await exchange(requires_redis, promotion="auto")
    assistant = memory.messages[-1]
    with (
        patch.object(
            capture.LLMClient,
            "create_chat_completion",
            new_callable=AsyncMock,
            return_value=model_result(
                memory, message_id=assistant.id, evidence=assistant.content
            ),
        ),
        patch.object(
            capture, "index_long_term_memories", new_callable=AsyncMock
        ) as index,
    ):
        await capture.process_capture(scope().model_dump())
        current = await capture.load_capture(requires_redis, scope())
        candidate = current.data["capture"]["candidates"][0]
        assert current.data["capture"]["status"] == "review"
        assert capture.capture_activity(current)["counts"]["awaiting_review"] == 1
        decision = capture.CandidateDecision(
            **scope().model_dump(), candidate_id=candidate["id"], action="promote"
        )
        await capture.decide_candidate(decision, requires_redis, automatic=True)
        index.assert_not_awaited()
        await capture.decide_candidate(decision, requires_redis)
    saved = index.call_args.args[0][0]
    assert saved.metadata["review"] == "manual"
    assert saved.metadata["source_role"] == "assistant"
    assert "evidence" not in saved.metadata
    assert "confidence" not in saved.metadata
    capture.HybridBackgroundTasks.add_task.assert_not_called()


@pytest.mark.asyncio
async def test_activity_only_marks_saved_after_index_success(
    requires_redis, monkeypatch
):
    monkeypatch.setattr(settings, "long_term_memory", True)
    memory = await exchange(requires_redis, promotion="auto")
    received = memory.data["capture"]["last_received_at"]

    async def index(*_args, **_kwargs):
        current = await capture.load_capture(requires_redis, scope())
        activity = capture.capture_activity(current)
        assert current.data["capture"]["status"] == "saving"
        assert activity["counts"]["saved"] == 0
        assert activity["last_saved_at"] is None

    with (
        patch.object(
            capture.LLMClient,
            "create_chat_completion",
            new_callable=AsyncMock,
            return_value=model_result(memory),
        ),
        patch.object(capture, "index_long_term_memories", side_effect=index),
    ):
        await capture.process_capture(scope().model_dump())
        current = await capture.load_capture(requires_redis, scope())
        activity = capture.capture_activity(current)
        await exchange(requires_redis, promotion="auto")
        await capture.process_capture(scope().model_dump())
    assert (
        capture.capture_activity(await capture.load_capture(requires_redis, scope()))
        == activity
    )
    assert activity["last_received_at"] == received
    assert activity["last_filtered_at"] and activity["last_saved_at"]
    assert activity["counts"]["captured"] == activity["counts"]["checked"] == 2
    assert activity["counts"]["saved"] == 1
    listing = await capture.sessions_endpoint(scope().user_id, scope().project_id)
    detail = await capture.session_endpoint(scope())
    assert listing["sessions"][0]["counts"] == detail["counts"] == activity["counts"]


@pytest.mark.asyncio
async def test_off_mode_stops_already_queued_continuation(requires_redis):
    await exchange(requires_redis, "1")
    await exchange(requires_redis, "2")
    with patch.object(
        capture.LLMClient,
        "create_chat_completion",
        new_callable=AsyncMock,
        return_value=SimpleNamespace(content='{"candidates": []}'),
    ) as model:
        await capture.process_capture(scope().model_dump())
        await capture.capture_event(event(turn="2", promotion="off"), requires_redis)
        job = capture.HybridBackgroundTasks.add_task.call_args
        await job.args[0](*job.args[1:])
    model.assert_awaited_once()
    current = await capture.load_capture(requires_redis, scope())
    assert current.data["capture"]["status"] == "capture only"


@pytest.mark.asyncio
async def test_docket_job_survives_scheduler_exit_and_retries_safe_failure(
    requires_redis, redis_url, monkeypatch
):
    monkeypatch.setattr(settings, "long_term_memory", True)
    memory = await exchange(requires_redis, promotion="auto")
    policy = capture.process_capture.__defaults__[0]
    assert policy.attempts == 3
    assert policy.delay == timedelta(seconds=30)
    # Exercise the real queue/retry path without waiting 30 seconds in a unit suite.
    monkeypatch.setattr(
        capture.process_capture,
        "__defaults__",
        (Retry(attempts=3, delay=timedelta(milliseconds=1)),),
    )
    name = f"capture-test-{TEST_SESSION}"
    async with Docket(name=name, url=redis_url) as docket:
        await docket.add(capture.process_capture)(scope().model_dump())
    with (
        patch.object(
            capture.LLMClient,
            "create_chat_completion",
            new_callable=AsyncMock,
            side_effect=[ValueError("private provider request"), model_result(memory)],
        ) as model,
        patch.object(
            capture, "index_long_term_memories", new_callable=AsyncMock
        ) as index,
    ):
        async with Docket(name=name, url=redis_url) as docket:
            docket.register(capture.process_capture)
            async with Worker(docket, schedule_automatic_tasks=False) as worker:
                await asyncio.wait_for(worker.run_until_finished(), timeout=15)
    assert model.await_count == 2
    index.assert_awaited_once()
    current = await capture.load_capture(requires_redis, scope())
    assert current.data["capture"]["status"] == "ready"
    assert "private provider request" not in json.dumps(current.data)


@pytest.mark.asyncio
async def test_filter_allowance_stops_next_call_and_reports_measured_usage(
    requires_redis, monkeypatch
):
    monkeypatch.setattr(settings, "working_memory_daily_filter_token_limit", 10)
    memory = await exchange(requires_redis, "1")
    await exchange(requires_redis, "2")
    with patch.object(
        capture.LLMClient,
        "create_chat_completion",
        new_callable=AsyncMock,
        return_value=model_result(memory),
    ) as model:
        await capture.process_capture(scope().model_dump())
        await capture.process_capture(scope().model_dump())
    model.assert_awaited_once()
    current = await capture.load_capture(requires_redis, scope())
    assert "daily allowance reached" in current.data["capture"]["status"]
    assert len(current.data["capture"]["processed"]) == 2
    usage = capture.capture_activity(current)["filter_usage"]
    assert usage == {
        "calls": 1,
        "unmeasured_calls": 0,
        "prompt_tokens": 40,
        "completion_tokens": 10,
        "total_tokens": 50,
    }
    detail = await capture.session_endpoint(scope())
    assert detail["daily_filter_usage"]["limit"] == 10
    assert detail["daily_filter_usage"]["total_tokens"] == 50
    assert 0 < await requires_redis.ttl(capture.filter_usage_key(scope())) <= 8 * 86400
    # The already-admitted response may exceed the threshold; it is not a billing hard cap.
    assert usage["total_tokens"] > detail["daily_filter_usage"]["limit"]
    assert capture.HybridBackgroundTasks.add_task.call_count == 1


@pytest.mark.asyncio
async def test_filter_allowance_is_shared_across_concurrent_project_sessions(
    requires_redis, monkeypatch
):
    monkeypatch.setattr(settings, "working_memory_daily_filter_token_limit", 10)
    await exchange(requires_redis)
    other = event().model_copy(update={"session_id": f"{TEST_SESSION}-other"})
    await capture.capture_event(other, requires_redis)
    other_scope = capture.CaptureScope(**other.model_dump())

    async def model(**_kwargs):
        await asyncio.sleep(0.03)
        return SimpleNamespace(
            content='{"candidates": []}',
            prompt_tokens=40,
            completion_tokens=10,
            total_tokens=50,
        )

    with patch.object(
        capture.LLMClient, "create_chat_completion", side_effect=model
    ) as generate:
        await asyncio.gather(
            capture.process_capture(scope().model_dump()),
            capture.process_capture(other_scope.model_dump()),
        )
    generate.assert_awaited_once()
    assert (await capture.daily_filter_usage(requires_redis, scope()))[
        "total_tokens"
    ] == 50
    different_user = scope().model_copy(update={"user_id": "other-user"})
    different_project = scope().model_copy(update={"project_id": "other/project"})
    assert (await capture.daily_filter_usage(requires_redis, different_user))[
        "total_tokens"
    ] == 0
    assert (await capture.daily_filter_usage(requires_redis, different_project))[
        "total_tokens"
    ] == 0


@pytest.mark.asyncio
async def test_invalid_filter_output_is_charged_and_retry_counts_new_call(
    requires_redis,
):
    memory = await exchange(requires_redis)
    invalid = model_result(memory)
    invalid.content = "not JSON"
    with patch.object(
        capture.LLMClient,
        "create_chat_completion",
        new_callable=AsyncMock,
        side_effect=[invalid, model_result(memory)],
    ) as model:
        with pytest.raises(RuntimeError):
            await capture.process_capture(scope().model_dump())
        await capture.process_capture(scope().model_dump())
        await capture.process_capture(scope().model_dump())
    assert model.await_count == 2
    usage = await capture.daily_filter_usage(requires_redis, scope())
    assert usage["calls"] == 2 and usage["total_tokens"] == 100
    assert usage["unmeasured_calls"] == 0


@pytest.mark.parametrize("failure", [True, False])
@pytest.mark.asyncio
async def test_unmeasured_filter_call_pauses_configured_allowance(
    requires_redis, monkeypatch, failure
):
    monkeypatch.setattr(settings, "working_memory_daily_filter_token_limit", 100)
    await exchange(requires_redis, "1")
    await exchange(requires_redis, "2")
    with patch.object(
        capture.LLMClient,
        "create_chat_completion",
        new_callable=AsyncMock,
        side_effect=ValueError("private data") if failure else None,
        return_value=SimpleNamespace(content='{"candidates": []}'),
    ) as model:
        if failure:
            with pytest.raises(RuntimeError):
                await capture.process_capture(scope().model_dump())
        else:
            await capture.process_capture(scope().model_dump())
        await capture.process_capture(scope().model_dump())
    model.assert_awaited_once()
    usage = await capture.daily_filter_usage(requires_redis, scope())
    assert usage["unmeasured_calls"] == usage["calls"] == 1
    current = await capture.load_capture(requires_redis, scope())
    assert "usage unknown" in current.data["capture"]["status"]
    assert "private data" not in json.dumps(current.data)


@pytest.mark.asyncio
async def test_filter_pause_does_not_block_already_filtered_saves(
    requires_redis, monkeypatch
):
    monkeypatch.setattr(settings, "working_memory_daily_filter_token_limit", 10)
    monkeypatch.setattr(settings, "long_term_memory", True)
    memory = await exchange(requires_redis)
    with patch.object(
        capture.LLMClient,
        "create_chat_completion",
        new_callable=AsyncMock,
        return_value=model_result(memory),
    ) as model:
        await capture.process_capture(scope().model_dump())
        await exchange(requires_redis, "2", promotion="auto")
        with patch.object(
            capture, "index_long_term_memories", new_callable=AsyncMock
        ) as index:
            await capture.process_capture(scope().model_dump())
    model.assert_awaited_once()
    index.assert_awaited_once()
    current = await capture.load_capture(requires_redis, scope())
    assert "daily allowance reached" in current.data["capture"]["status"]
    assert capture.capture_activity(current)["counts"]["saved"] == 1


@pytest.mark.asyncio
async def test_filter_usage_does_not_restore_session_expired_during_model_call(
    requires_redis,
):
    memory = await exchange(requires_redis)

    async def model(**_kwargs):
        await requires_redis.pexpire(scope().key(), 1)
        await asyncio.sleep(0.02)
        return model_result(memory)

    with patch.object(capture.LLMClient, "create_chat_completion", side_effect=model):
        await capture.process_capture(scope().model_dump())
    assert await capture.load_capture(requires_redis, scope()) is None
    assert (await capture.daily_filter_usage(requires_redis, scope()))[
        "total_tokens"
    ] == 50


@pytest.mark.asyncio
async def test_automatic_fact_is_recalled_from_real_index_after_source_chat_expires(
    requires_redis, monkeypatch
):
    monkeypatch.setattr(settings, "long_term_memory", True)
    monkeypatch.setattr(settings, "redisvl_index_name", f"capture-proof-{TEST_SESSION}")
    monkeypatch.setattr(
        settings, "redisvl_index_prefix", f"capture-proof-{TEST_SESSION}"
    )
    monkeypatch.setattr(settings, "embedding_model", "text-embedding-3-small")
    fact = "example/shop uses Cedar Finch as its sample customer name."
    await capture.capture_event(event(text=fact, promotion="auto"), requires_redis)
    memory = await capture.capture_event(
        event(
            "assistant",
            "Confirmed: Cedar Finch is the sample customer name.",
            promotion="auto",
        ),
        requires_redis,
    )
    embeddings = SimpleNamespace(
        aembed_documents=AsyncMock(return_value=[[0.1] * 1536]),
        aembed_query=AsyncMock(return_value=[0.1] * 1536),
    )
    # Keep the real database factory, Redis indexing and search paths. Only the
    # provider outputs are fake; conftest points every connection at test Redis.
    with (
        patch(
            "agent_memory_server.memory_vector_db_factory.create_embeddings",
            return_value=embeddings,
        ),
        patch.object(
            capture.LLMClient,
            "create_chat_completion",
            new_callable=AsyncMock,
            return_value=model_result(memory, text=fact),
        ) as model,
    ):
        await capture.process_capture(scope().model_dump())
        current = await capture.load_capture(requires_redis, scope())
        candidate = current.data["capture"]["candidates"][0]
        assert candidate["status"] == "promoted"
        memory_id = candidate["id"]
        assert memory_id.startswith("wm-")
        # A repeated delivery must not make a second permanent record.
        await capture.process_capture(scope().model_dump())
        repeated = await capture.decide_candidate(
            capture.CandidateDecision(
                **scope().model_dump(), candidate_id=memory_id, action="promote"
            ),
            requires_redis,
            automatic=True,
        )
        assert repeated["id"] == memory_id
        await requires_redis.pexpire(scope().key(), 1)
        await asyncio.sleep(0.02)
        assert await capture.load_capture(requires_redis, scope()) is None
        result = await capture.recall_endpoint(
            user_id=scope().user_id,
            project_id=scope().project_id,
            include_long_term=True,
            query="Cedar Finch",
        )
    assert result["context"] == ""  # No recent chat can supply this answer.
    assert result["long_term_status"] == "found"
    assert result["memory_ids"] == [memory_id]
    assert json.loads(result["long_term_context"]) == [{"id": memory_id, "text": fact}]
    assert await capture.load_capture(requires_redis, scope()) is None
    model.assert_awaited_once()
    embeddings.aembed_documents.assert_awaited_once_with([fact])
    embeddings.aembed_query.assert_not_awaited()  # Recall is keyword-only.


@pytest.mark.parametrize("change", ["private", "edited", "evicted"])
@pytest.mark.asyncio
async def test_filter_refreshes_capture_after_waiting_for_allowance(
    requires_redis, monkeypatch, change
):
    monkeypatch.setattr(settings, "working_memory_daily_filter_token_limit", 1000)
    monkeypatch.setattr(capture, "MAX_TURNS", 1)
    old_text = "The old storage choice before review."
    new_text = "The new storage choice after review."
    await capture.capture_event(event(text=old_text), requires_redis)
    lock_key = (
        f"{capture.filter_usage_key(scope()).rsplit(':', 1)[-1]}:filter-budget-lock"
    )

    async def wait_for_filter():
        while True:
            memory = await capture.load_capture(requires_redis, scope())
            if memory.data["capture"]["status"] == "filtering":
                return
            await asyncio.sleep(0.001)

    with patch.object(
        capture.LLMClient,
        "create_chat_completion",
        new_callable=AsyncMock,
        return_value=SimpleNamespace(
            content='{"candidates": []}',
            prompt_tokens=40,
            completion_tokens=10,
            total_tokens=50,
        ),
    ) as model:
        async with requires_redis.lock(lock_key, timeout=10):
            task = asyncio.create_task(capture.process_capture(scope().model_dump()))
            await asyncio.wait_for(wait_for_filter(), timeout=2)
            await capture.capture_event(
                event(
                    text="<private>Redacted exchange</private>"
                    if change == "private"
                    else new_text,
                    turn="2" if change == "evicted" else "1",
                ),
                requires_redis,
            )
        await asyncio.wait_for(task, timeout=5)
    if change == "private":
        model.assert_not_awaited()
        assert (await capture.daily_filter_usage(requires_redis, scope()))["calls"] == 0
    else:
        model.assert_awaited_once()
        sent = json.loads(model.call_args.kwargs["messages"][1]["content"])["messages"]
        assert [message["content"] for message in sent] == [new_text]
        assert old_text not in json.dumps(sent)


async def make_handoff(redis, monkeypatch):
    monkeypatch.setattr(settings, "working_memory_handoff_enabled", True)
    monkeypatch.setattr(capture, "MAX_TURNS", 1)
    memory = await exchange(redis)
    with (
        patch.object(
            capture.LLMClient,
            "create_chat_completion",
            new_callable=AsyncMock,
            return_value=model_result(memory),
        ) as model,
        patch.object(
            capture, "index_long_term_memories", new_callable=AsyncMock
        ) as index,
    ):
        await capture.process_capture(scope().model_dump())
        await capture.capture_event(
            event(turn="2", text="An unrelated new request."), redis
        )
    model.assert_awaited_once()  # Trimming adds no model call.
    index.assert_not_awaited()
    return await capture.load_capture(redis, scope())


@pytest.mark.asyncio
async def test_handoff_keeps_user_evidence_separate_from_facts(
    requires_redis, monkeypatch
):
    memory = await make_handoff(requires_redis, monkeypatch)
    state = memory.data["capture"]
    assert state["candidates"] == []
    assert len(state["handoff"]) == 1
    item = state["handoff"][0]
    assert item["text"] == "example/shop uses Redis for session storage."
    assert item["evidence"] == "This project uses Redis for session storage."
    assert item["source_role"] == "user"
    assert capture.datetime.fromisoformat(
        item["expires_at"]
    ) - capture.datetime.fromisoformat(item["source_created_at"]) == timedelta(
        seconds=capture.TTL_SECONDS
    )
    result = await capture.recall_endpoint(
        user_id=scope().user_id, project_id=scope().project_id
    )
    recalled = json.loads(result["context"])[0]
    assert recalled["handoff"]["kind"] == "untrusted user-evidenced excerpts"
    assert recalled["handoff"]["items"] == [item]
    assert all(m["content"] != item["evidence"] for m in recalled["messages"])
    assert capture.capture_activity(memory)["handoff_count"] == 1
    with (
        patch.object(
            capture, "index_long_term_memories", new_callable=AsyncMock
        ) as index,
        pytest.raises(HTTPException) as error,
    ):
        await capture.decide_candidate(
            capture.CandidateDecision(
                **scope().model_dump(), candidate_id=item["id"], action="promote"
            ),
            requires_redis,
        )
    assert error.value.status_code == 404
    index.assert_not_awaited()


@pytest.mark.parametrize(
    "change", ["private", "edit", "dismiss", "disabled", "expired"]
)
@pytest.mark.asyncio
async def test_handoff_retraction_and_expiry_apply_to_recall(
    requires_redis, monkeypatch, change
):
    memory = await make_handoff(requires_redis, monkeypatch)
    item = memory.data["capture"]["handoff"][0]
    await requires_redis.expire(scope().key(), 123)
    if change == "private":
        await capture.capture_event(
            event(
                "assistant",
                "<private>Do not retain the old exchange</private>",
                turn="1",
            ),
            requires_redis,
        )
    elif change == "edit":
        await capture.capture_event(
            event(text="The old storage choice has changed.", turn="1"), requires_redis
        )
    elif change == "dismiss":
        result = await capture.decide_candidate(
            capture.CandidateDecision(
                **scope().model_dump(), candidate_id=item["id"], action="dismiss"
            ),
            requires_redis,
        )
        assert result["status"] == "dismissed"
    elif change == "disabled":
        monkeypatch.setattr(settings, "working_memory_handoff_enabled", False)
    else:
        await requires_redis.json().set(
            scope().key(),
            "$.data.capture.handoff[0].expires_at",
            "2000-01-01T00:00:00+00:00",
        )
    result = await capture.recall_endpoint(
        user_id=scope().user_id, project_id=scope().project_id
    )
    assert all(
        "handoff" not in session for session in json.loads(result["context"] or "[]")
    )
    assert (await capture.load_capture(requires_redis, scope())).data["capture"].get(
        "handoff", []
    ) == []
    if change in ("dismiss", "disabled", "expired"):
        assert await requires_redis.ttl(scope().key()) <= 123


@pytest.mark.asyncio
async def test_handoff_is_bounded_and_does_not_restore_expired_sessions(
    requires_redis, monkeypatch
):
    monkeypatch.setattr(settings, "working_memory_handoff_enabled", True)
    monkeypatch.setattr(capture, "MAX_TURNS", 1)
    with patch.object(
        capture.LLMClient, "create_chat_completion", new_callable=AsyncMock
    ) as model:
        for turn in range(12):
            memory = await capture.capture_event(
                event(
                    text=f"Project convention {turn}: " + "Use clear labels. " * 25,
                    turn=str(turn),
                ),
                requires_redis,
            )
            model.return_value = model_result(
                memory,
                text=f"example/shop convention {turn}: " + "Use clear labels. " * 25,
                evidence=memory.messages[0].content[:400],
            )
            await capture.process_capture(scope().model_dump())
        await capture.capture_event(event(turn="12"), requires_redis)
    memory = await capture.load_capture(requires_redis, scope())
    assert 0 < len(memory.data["capture"]["handoff"]) <= 6
    assert (
        len(json.dumps(memory.data["capture"]["handoff"], ensure_ascii=False)) <= 4000
    )
    assert model.await_count == 12
    await requires_redis.pexpire(scope().key(), 1)
    await asyncio.sleep(0.02)
    assert await capture.load_capture(requires_redis, scope()) is None
    recalled = await capture.recall_endpoint(
        user_id=scope().user_id, project_id=scope().project_id
    )
    assert recalled["context"] == ""
    assert await capture.load_capture(requires_redis, scope()) is None


@pytest.mark.asyncio
async def test_handoff_omits_dismissed_and_assistant_only_candidates(
    requires_redis, monkeypatch
):
    monkeypatch.setattr(settings, "working_memory_handoff_enabled", True)
    monkeypatch.setattr(capture, "MAX_TURNS", 1)
    memory = await exchange(requires_redis)
    assistant = memory.messages[-1]
    response = model_result(memory)
    second = json.loads(
        model_result(
            memory,
            text="example/shop assistant-only suggestion for review.",
            message_id=assistant.id,
            evidence=assistant.content,
        ).content
    )["candidates"][0]
    payload = json.loads(response.content)
    payload["candidates"].append(second)
    response.content = json.dumps(payload)
    with patch.object(
        capture.LLMClient,
        "create_chat_completion",
        new_callable=AsyncMock,
        return_value=response,
    ):
        await capture.process_capture(scope().model_dump())
    memory = await capture.load_capture(requires_redis, scope())
    await capture.decide_candidate(
        capture.CandidateDecision(
            **scope().model_dump(),
            candidate_id=memory.data["capture"]["candidates"][0]["id"],
            action="dismiss",
        ),
        requires_redis,
    )
    await capture.capture_event(event(turn="2"), requires_redis)
    assert (await capture.load_capture(requires_redis, scope())).data["capture"][
        "handoff"
    ] == []


@pytest.mark.asyncio
async def test_handoff_yields_to_a_current_candidate_with_the_same_stable_id(
    requires_redis, monkeypatch
):
    memory = await make_handoff(requires_redis, monkeypatch)
    previous = memory.data["capture"]["handoff"][0]
    monkeypatch.setattr(settings, "long_term_memory", True)
    memory = await capture.capture_event(
        event(text=previous["evidence"], turn="2", promotion="auto"), requires_redis
    )
    with (
        patch.object(
            capture.LLMClient,
            "create_chat_completion",
            new_callable=AsyncMock,
            return_value=model_result(memory, text=previous["text"]),
        ),
        patch.object(
            capture, "index_long_term_memories", new_callable=AsyncMock
        ) as index,
    ):
        await capture.process_capture(scope().model_dump())
        current = await capture.load_capture(requires_redis, scope())
        candidate = current.data["capture"]["candidates"][0]
        assert candidate["id"] == previous["id"]
        assert candidate["status"] == "promoted"
        assert current.data["capture"]["handoff"] == []
        # A stale Forget click cannot alter the current promoted fact; the old
        # excerpt is already gone, so there is only one visible source for this ID.
        await capture.decide_candidate(
            capture.CandidateDecision(
                **scope().model_dump(), candidate_id=previous["id"], action="dismiss"
            ),
            requires_redis,
        )
    index.assert_awaited_once()
    detail = await capture.session_endpoint(scope())
    assert detail["handoff_count"] == 0
    assert detail["memory"].data["capture"]["candidates"][0]["status"] == "promoted"
    recalled = await capture.recall_endpoint(
        user_id=scope().user_id, project_id=scope().project_id
    )
    assert "handoff" not in json.loads(recalled["context"])[0]
