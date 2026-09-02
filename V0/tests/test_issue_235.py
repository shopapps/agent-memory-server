"""Tests for safe working-memory key resolution after GitHub issue #235.

The index can recover a key when non-owner details are omitted. Omitted owner
scopes mean shared, so they never expose or delete private user data.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest

from agent_memory_server.models import MemoryMessage, WorkingMemory
from agent_memory_server.utils.keys import Keys
from agent_memory_server.working_memory import (
    _resolve_working_memory_key_via_index,
    delete_working_memory,
    get_working_memory,
    set_working_memory,
)


class TestIssue235KeyResolution:
    """Verify safe GET and DELETE fallback behavior."""

    def test_keys_differ_when_scoping_params_vary(self):
        """Confirm that the raw key function produces different keys -- this is
        intentional for multi-tenancy.  The fix is in the lookup layer, not here."""
        session_id = "test-session"
        key_full = Keys.working_memory_key(
            session_id=session_id, user_id="alice", namespace="demo"
        )
        key_bare = Keys.working_memory_key(session_id=session_id)

        assert key_full == (
            "working_memory:v1:demo:__shared__:alice:__shared__:test-session"
        )
        assert key_bare == (
            "working_memory:v1:__shared__:__shared__:__shared__:__shared__:test-session"
        )
        assert key_full != key_bare

    def test_working_memory_key_escapes_scope_separators(self):
        key = Keys.working_memory_key(
            session_id="session:1",
            namespace="coding/umony",
            project_id="project:a",
            user_id="user:a",
            agent_id="agent:a",
        )

        assert key == (
            "working_memory:v1:coding%2Fumony:project%3Aa:user%3Aa:"
            "agent%3Aa:session%3A1"
        )

    @pytest.mark.asyncio
    async def test_index_resolution_filters_omitted_scopes_to_shared(self):
        private_key = "working_memory:v1:demo:project-a:alice:agent-a:session-1"
        shared_key = "working_memory:v1:demo:__shared__:alice:__shared__:session-1"
        index = Mock()
        index.search = AsyncMock(
            return_value=SimpleNamespace(
                docs=[
                    SimpleNamespace(id=private_key),
                    SimpleNamespace(id=shared_key),
                ],
                total=2,
            )
        )
        json_commands = Mock()
        json_commands.get = AsyncMock(
            side_effect=[
                {
                    "session_id": "session-1",
                    "namespace": "demo",
                    "project_id": "project-a",
                    "user_id": "alice",
                    "agent_id": "agent-a",
                },
                {
                    "session_id": "session-1",
                    "namespace": "demo",
                    "project_id": "__shared__",
                    "user_id": "alice",
                    "agent_id": "__shared__",
                },
            ]
        )
        redis = Mock()
        redis.json.return_value = json_commands

        with patch(
            "agent_memory_server.working_memory_index.get_working_memory_index",
            new=AsyncMock(return_value=index),
        ):
            resolved = await _resolve_working_memory_key_via_index(
                redis,
                session_id="session-1",
                user_id="alice",
                namespace="demo",
            )

        assert resolved == shared_key

    @pytest.mark.asyncio
    async def test_get_resolves_via_index_when_namespace_is_omitted(
        self, async_redis_client
    ):
        """The exact user can resolve one session without its namespace."""
        if async_redis_client is None:
            pytest.skip("Redis not available")

        session_id = "issue-235-get-resolve"
        user_id = "alice"
        namespace = "demo"

        working_mem = WorkingMemory(
            session_id=session_id,
            user_id=user_id,
            namespace=namespace,
            messages=[MemoryMessage(role="user", content="Hello")],
            memories=[],
        )
        await set_working_memory(working_mem, redis_client=async_redis_client)

        # The owner is explicit. The index can safely recover the namespace.
        result = await get_working_memory(
            session_id=session_id,
            user_id=user_id,
            redis_client=async_redis_client,
        )

        assert result is not None
        assert result.session_id == session_id
        assert result.user_id == user_id
        assert result.namespace == namespace
        assert len(result.messages) == 1
        assert result.messages[0].content == "Hello"

    @pytest.mark.asyncio
    async def test_namespace_without_user_does_not_resolve_private_session(
        self, async_redis_client
    ):
        if async_redis_client is None:
            pytest.skip("Redis not available")

        session_id = "issue-235-partial"
        user_id = "bob"
        namespace = "staging"

        working_mem = WorkingMemory(
            session_id=session_id,
            user_id=user_id,
            namespace=namespace,
            messages=[MemoryMessage(role="user", content="Partial test")],
            memories=[],
        )
        await set_working_memory(working_mem, redis_client=async_redis_client)

        # GET with namespace but without user_id
        result = await get_working_memory(
            session_id=session_id,
            namespace=namespace,
            redis_client=async_redis_client,
        )

        assert result is None

    @pytest.mark.asyncio
    async def test_get_with_correct_params_still_uses_fast_path(
        self, async_redis_client
    ):
        """GET with matching params hits the direct key (no fallback needed)."""
        if async_redis_client is None:
            pytest.skip("Redis not available")

        session_id = "issue-235-fast"
        user_id = "carol"
        namespace = "prod"

        working_mem = WorkingMemory(
            session_id=session_id,
            user_id=user_id,
            namespace=namespace,
            messages=[MemoryMessage(role="assistant", content="Fast path")],
            memories=[],
        )
        await set_working_memory(working_mem, redis_client=async_redis_client)

        result = await get_working_memory(
            session_id=session_id,
            user_id=user_id,
            namespace=namespace,
            redis_client=async_redis_client,
        )

        assert result is not None
        assert result.session_id == session_id

    @pytest.mark.asyncio
    async def test_same_session_id_is_isolated_by_project_and_agent(
        self, async_redis_client
    ):
        first = WorkingMemory(
            session_id="shared-session-id",
            namespace="demo",
            project_id="project-a",
            user_id="alice",
            agent_id="agent-a",
            context="first",
        )
        second = first.model_copy(
            update={
                "project_id": "project-b",
                "agent_id": "agent-b",
                "context": "second",
            }
        )

        await set_working_memory(first, redis_client=async_redis_client)
        await set_working_memory(second, redis_client=async_redis_client)

        first_result = await get_working_memory(
            session_id="shared-session-id",
            namespace="demo",
            project_id="project-a",
            user_id="alice",
            agent_id="agent-a",
            redis_client=async_redis_client,
        )
        second_result = await get_working_memory(
            session_id="shared-session-id",
            namespace="demo",
            project_id="project-b",
            user_id="alice",
            agent_id="agent-b",
            redis_client=async_redis_client,
        )
        ambiguous = await get_working_memory(
            session_id="shared-session-id",
            redis_client=async_redis_client,
        )

        assert first_result is not None and first_result.context == "first"
        assert second_result is not None and second_result.context == "second"
        assert ambiguous is None

        await delete_working_memory(
            session_id="shared-session-id",
            namespace="demo",
            project_id="project-a",
            user_id="alice",
            agent_id="agent-a",
            redis_client=async_redis_client,
        )
        assert (
            await get_working_memory(
                session_id="shared-session-id",
                namespace="demo",
                project_id="project-b",
                user_id="alice",
                agent_id="agent-b",
                redis_client=async_redis_client,
            )
            is not None
        )

    @pytest.mark.asyncio
    async def test_omitted_scope_never_reads_or_deletes_private_v1_memory(
        self, async_redis_client
    ):
        if async_redis_client is None:
            pytest.skip("Redis not available")

        private = WorkingMemory(
            session_id="private-v1-session",
            namespace="demo",
            project_id="project-a",
            user_id="alice",
            agent_id="agent-a",
            context="private",
        )
        await set_working_memory(private, redis_client=async_redis_client)

        omitted_scope_lookups = [
            {},
            {"project_id": "project-a"},
            {"agent_id": "agent-a"},
        ]
        for scopes in omitted_scope_lookups:
            assert (
                await get_working_memory(
                    session_id=private.session_id,
                    namespace=private.namespace,
                    user_id=private.user_id,
                    redis_client=async_redis_client,
                    **scopes,
                )
                is None
            )
            await delete_working_memory(
                session_id=private.session_id,
                namespace=private.namespace,
                user_id=private.user_id,
                redis_client=async_redis_client,
                **scopes,
            )

        exact = await get_working_memory(
            session_id=private.session_id,
            namespace=private.namespace,
            project_id=private.project_id,
            user_id=private.user_id,
            agent_id=private.agent_id,
            redis_client=async_redis_client,
        )
        assert exact is not None
        assert exact.context == "private"

    @pytest.mark.asyncio
    async def test_omitted_user_never_reads_or_deletes_private_v1_memory(
        self, async_redis_client
    ):
        private = WorkingMemory(
            session_id="private-user-session",
            namespace="demo",
            user_id="alice",
            context="private user",
        )
        await set_working_memory(private, redis_client=async_redis_client)

        assert (
            await get_working_memory(
                session_id=private.session_id,
                namespace=private.namespace,
                redis_client=async_redis_client,
            )
            is None
        )

        await delete_working_memory(
            session_id=private.session_id,
            namespace=private.namespace,
            redis_client=async_redis_client,
        )

        exact = await get_working_memory(
            session_id=private.session_id,
            namespace=private.namespace,
            user_id=private.user_id,
            redis_client=async_redis_client,
        )
        assert exact is not None
        assert exact.context == "private user"

    @pytest.mark.asyncio
    async def test_old_working_memory_key_remains_readable(self, async_redis_client):
        if async_redis_client is None:
            pytest.skip("Redis not available")

        legacy_key = Keys.legacy_working_memory_key(
            session_id="legacy-session",
            user_id="legacy-user",
            namespace="legacy-ns",
        )
        await async_redis_client.json().set(
            legacy_key,
            "$",
            {
                "messages": [],
                "memories": [],
                "session_id": "legacy-session",
                "namespace": "legacy-ns",
                "user_id": "legacy-user",
                "context": "old key",
            },
        )

        result = await get_working_memory(
            session_id="legacy-session",
            user_id="legacy-user",
            namespace="legacy-ns",
            redis_client=async_redis_client,
        )

        assert result is not None
        assert result.context == "old key"

    @pytest.mark.asyncio
    async def test_delete_resolves_via_index_when_namespace_is_omitted(
        self, async_redis_client
    ):
        """The exact user can safely delete without repeating the namespace."""
        if async_redis_client is None:
            pytest.skip("Redis not available")

        session_id = "issue-235-delete"
        user_id = "dave"
        namespace = "test"

        working_mem = WorkingMemory(
            session_id=session_id,
            user_id=user_id,
            namespace=namespace,
            messages=[MemoryMessage(role="user", content="To be deleted")],
            memories=[],
        )
        await set_working_memory(working_mem, redis_client=async_redis_client)

        # Verify it exists
        result = await get_working_memory(
            session_id=session_id,
            user_id=user_id,
            namespace=namespace,
            redis_client=async_redis_client,
        )
        assert result is not None

        # The owner is explicit. The index can safely recover the namespace.
        await delete_working_memory(
            session_id=session_id,
            user_id=user_id,
            redis_client=async_redis_client,
        )

        # Verify it's gone
        result_after = await get_working_memory(
            session_id=session_id,
            user_id=user_id,
            namespace=namespace,
            redis_client=async_redis_client,
        )
        assert result_after is None, "Session should be deleted"

    @pytest.mark.asyncio
    async def test_api_get_requires_the_private_user_scope(self, client):
        if client is None:
            pytest.skip("Client not available")

        session_id = "issue-235-api"

        # PUT with user_id and namespace in the request body
        put_response = await client.put(
            f"/v1/working-memory/{session_id}",
            json={
                "messages": [{"role": "user", "content": "Hello from API test"}],
                "user_id": "alice",
                "namespace": "demo",
            },
        )
        assert put_response.status_code == 200

        # An omitted user means shared-only and cannot expose Alice's session.
        get_response = await client.get(f"/v1/working-memory/{session_id}")
        assert get_response.status_code == 404

        scoped_response = await client.get(
            f"/v1/working-memory/{session_id}",
            params={"user_id": "alice"},
        )
        assert scoped_response.status_code == 200
        data = scoped_response.json()
        assert data["session_id"] == session_id
        assert data["user_id"] == "alice"
        assert data["namespace"] == "demo"
        assert len(data["messages"]) == 1

    @pytest.mark.asyncio
    async def test_api_delete_without_user_keeps_private_session(self, client):
        if client is None:
            pytest.skip("Client not available")

        session_id = "issue-235-api-delete"

        # PUT with user_id and namespace in body
        put_response = await client.put(
            f"/v1/working-memory/{session_id}",
            json={
                "messages": [{"role": "user", "content": "Delete me"}],
                "user_id": "alice",
                "namespace": "demo",
            },
        )
        assert put_response.status_code == 200

        # DELETE without query params
        delete_response = await client.delete(f"/v1/working-memory/{session_id}")
        assert delete_response.status_code == 200

        # The unscoped delete is shared-only, so Alice's session remains.
        get_response = await client.get(
            f"/v1/working-memory/{session_id}",
            params={"user_id": "alice", "namespace": "demo"},
        )
        assert get_response.status_code == 200

        scoped_delete = await client.delete(
            f"/v1/working-memory/{session_id}",
            params={"user_id": "alice"},
        )
        assert scoped_delete.status_code == 200
        get_after_delete = await client.get(
            f"/v1/working-memory/{session_id}",
            params={"user_id": "alice", "namespace": "demo"},
        )
        assert get_after_delete.status_code == 404

    @pytest.mark.asyncio
    async def test_nonexistent_session_still_returns_none(self, async_redis_client):
        """A session that never existed should still return None."""
        if async_redis_client is None:
            pytest.skip("Redis not available")

        result = await get_working_memory(
            session_id="truly-nonexistent-session-xyz",
            redis_client=async_redis_client,
        )
        assert result is None


class TestIssue235MultiTenantIsolation:
    """Verify that multi-tenant isolation is preserved and ambiguity is handled."""

    @pytest.mark.asyncio
    async def test_direct_lookups_return_correct_tenant(self, async_redis_client):
        """Two sessions with the same ID in different namespaces stay separate
        when looked up with full scoping parameters."""
        if async_redis_client is None:
            pytest.skip("Redis not available")

        session_id = "shared-session-id"

        # Tenant A
        mem_a = WorkingMemory(
            session_id=session_id,
            user_id="user-a",
            namespace="tenant-a",
            messages=[MemoryMessage(role="user", content="Tenant A message")],
            memories=[],
        )
        await set_working_memory(mem_a, redis_client=async_redis_client)

        # Tenant B
        mem_b = WorkingMemory(
            session_id=session_id,
            user_id="user-b",
            namespace="tenant-b",
            messages=[MemoryMessage(role="user", content="Tenant B message")],
            memories=[],
        )
        await set_working_memory(mem_b, redis_client=async_redis_client)

        # Direct lookups return correct data
        result_a = await get_working_memory(
            session_id=session_id,
            user_id="user-a",
            namespace="tenant-a",
            redis_client=async_redis_client,
        )
        assert result_a is not None
        assert result_a.namespace == "tenant-a"
        assert result_a.messages[0].content == "Tenant A message"

        result_b = await get_working_memory(
            session_id=session_id,
            user_id="user-b",
            namespace="tenant-b",
            redis_client=async_redis_client,
        )
        assert result_b is not None
        assert result_b.namespace == "tenant-b"
        assert result_b.messages[0].content == "Tenant B message"

    @pytest.mark.asyncio
    async def test_namespace_filter_does_not_bypass_private_user_scope(
        self, async_redis_client
    ):
        if async_redis_client is None:
            pytest.skip("Redis not available")

        session_id = "shared-session-ns"

        for tenant in ("tenant-x", "tenant-y"):
            mem = WorkingMemory(
                session_id=session_id,
                user_id=f"user-{tenant}",
                namespace=tenant,
                messages=[MemoryMessage(role="user", content=f"Message from {tenant}")],
                memories=[],
            )
            await set_working_memory(mem, redis_client=async_redis_client)

        result_x = await get_working_memory(
            session_id=session_id,
            namespace="tenant-x",
            redis_client=async_redis_client,
        )
        assert result_x is None

        exact_x = await get_working_memory(
            session_id=session_id,
            namespace="tenant-x",
            user_id="user-tenant-x",
            redis_client=async_redis_client,
        )
        assert exact_x is not None
        assert exact_x.messages[0].content == "Message from tenant-x"

    @pytest.mark.asyncio
    async def test_ambiguous_lookup_returns_none(self, async_redis_client):
        """When multiple sessions share a session_id and no scoping params are
        provided, the fallback refuses to guess and returns None."""
        if async_redis_client is None:
            pytest.skip("Redis not available")

        session_id = "ambiguous-session-id"

        for i in range(2):
            mem = WorkingMemory(
                session_id=session_id,
                user_id=f"user-{i}",
                namespace=f"ns-{i}",
                messages=[MemoryMessage(role="user", content=f"Message {i}")],
                memories=[],
            )
            await set_working_memory(mem, redis_client=async_redis_client)

        # Bare lookup (no namespace/user_id) -- ambiguous, should return None
        result = await get_working_memory(
            session_id=session_id,
            redis_client=async_redis_client,
        )
        assert result is None, (
            "Ambiguous session_id without scoping params should return None"
        )

        # But each tenant can still be reached with correct scoping
        for i in range(2):
            result = await get_working_memory(
                session_id=session_id,
                user_id=f"user-{i}",
                namespace=f"ns-{i}",
                redis_client=async_redis_client,
            )
            assert result is not None
            assert result.namespace == f"ns-{i}"
