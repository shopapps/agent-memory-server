"""Working memory management for sessions."""

import json
import logging
import time
from datetime import UTC, datetime

from redis.asyncio import Redis
from redisvl.query import FilterQuery
from redisvl.query.filter import Tag

from agent_memory_server.config import settings
from agent_memory_server.models import (
    MemoryMessage,
    MemoryRecord,
    MemoryStrategyConfig,
    WorkingMemory,
)
from agent_memory_server.scopes import decode_scope, encode_scope
from agent_memory_server.utils.keys import Keys
from agent_memory_server.utils.redis import get_redis_conn


logger = logging.getLogger(__name__)

# Redis keys for migration status (shared across workers, persists across restarts)
MIGRATION_STATUS_KEY = "working_memory:migration:complete"
MIGRATION_REMAINING_KEY = "working_memory:migration:remaining"
MAX_WORKING_MEMORY_RESOLUTION_CANDIDATES = 100


def _working_memory_data_matches_scopes(
    data: dict,
    user_id: str | None,
    project_id: str | None,
    agent_id: str | None,
    namespace: str | None,
    session_id: str,
) -> bool:
    """Match the full stored identity; omitted owner scopes mean shared."""
    stored_user_id = encode_scope(decode_scope(data.get("user_id")))
    stored_project_id = encode_scope(decode_scope(data.get("project_id")))
    stored_agent_id = encode_scope(decode_scope(data.get("agent_id")))
    return (
        (namespace is None or data.get("namespace") == namespace)
        and data.get("session_id") == session_id
        and stored_user_id == encode_scope(user_id)
        and stored_project_id == encode_scope(project_id)
        and stored_agent_id == encode_scope(agent_id)
    )


async def _read_working_memory_data(redis_client: Redis, key: str) -> dict | None:
    """Read current JSON or legacy string data without changing its key."""
    key_type = await redis_client.type(key)
    if isinstance(key_type, bytes):
        key_type = key_type.decode("utf-8")

    if key_type == "ReJSON-RL":
        return await redis_client.json().get(key)
    if key_type == "string":
        raw_data = await redis_client.get(key)
        if isinstance(raw_data, bytes):
            raw_data = raw_data.decode("utf-8")
        if raw_data:
            return json.loads(raw_data)
    return None


async def check_and_set_migration_status(redis_client: Redis | None = None) -> bool:
    """
    Check if any working memory keys are still in old string format.
    Stores migration status in Redis for cross-worker consistency.

    If WORKING_MEMORY_MIGRATION_COMPLETE=true is set, skips the scan entirely
    and assumes all keys are in JSON format.

    Args:
        redis_client: Optional Redis client

    Returns:
        True if all keys are migrated (or no keys exist), False if string keys remain
    """
    # If env variable is set, skip the scan entirely
    if settings.working_memory_migration_complete:
        logger.info(
            "WORKING_MEMORY_MIGRATION_COMPLETE=true, skipping backward compatibility checks."
        )
        return True

    if not redis_client:
        redis_client = await get_redis_conn()

    # Check if migration status is already stored in Redis
    status = await redis_client.get(MIGRATION_STATUS_KEY)
    if status:
        if isinstance(status, bytes):
            status = status.decode("utf-8")
        if status == "true":
            logger.info(
                "Migration status in Redis indicates complete. Skipping type checks."
            )
            return True

    # Scan for working_memory:* keys of type STRING only
    # This is much faster than scanning all keys and calling TYPE on each
    cursor = 0
    string_keys_found = 0

    try:
        while True:
            # Use _type="string" to only get string keys directly
            cursor, keys = await redis_client.scan(
                cursor=cursor, match="working_memory:*", count=1000, _type="string"
            )

            if keys:
                # Filter out migration status keys (they're also strings)
                keys = [
                    k
                    for k in keys
                    if (k.decode("utf-8") if isinstance(k, bytes) else k)
                    not in (MIGRATION_STATUS_KEY, MIGRATION_REMAINING_KEY)
                ]
                string_keys_found += len(keys)

            if cursor == 0:
                break

        if string_keys_found > 0:
            # Store the count in Redis for atomic decrement during lazy migration
            await redis_client.set(MIGRATION_REMAINING_KEY, str(string_keys_found))
            logger.info(
                f"Found {string_keys_found} working memory keys in old string format. "
                "Lazy migration enabled."
            )
            return False

        # No string keys found - mark as complete in Redis
        await redis_client.set(MIGRATION_STATUS_KEY, "true")
        await redis_client.delete(MIGRATION_REMAINING_KEY)

        logger.info(
            "No working memory string keys found. Skipping backward compatibility checks."
        )
        return True
    except Exception as e:
        logger.error(f"Failed to check migration status: {e}")
        return False


async def _decrement_remaining_count(redis_client: Redis) -> None:
    """
    Atomically decrement the remaining string key counter.
    When it reaches 0, mark migration as complete.
    """
    try:
        remaining = await redis_client.decr(MIGRATION_REMAINING_KEY)
        if remaining <= 0:
            await redis_client.set(MIGRATION_STATUS_KEY, "true")
            await redis_client.delete(MIGRATION_REMAINING_KEY)
            logger.info("All working memory keys have been migrated to JSON format.")
    except Exception as e:
        # Non-fatal - migration still works, just won't auto-complete
        logger.warning(f"Failed to decrement migration counter: {e}")


async def is_migration_complete(redis_client: Redis | None = None) -> bool:
    """Check if migration is complete."""
    if settings.working_memory_migration_complete:
        return True

    if not redis_client:
        redis_client = await get_redis_conn()

    status = await redis_client.get(MIGRATION_STATUS_KEY)
    if status:
        if isinstance(status, bytes):
            status = status.decode("utf-8")
        return status == "true"
    return False


async def get_remaining_string_keys(redis_client: Redis | None = None) -> int:
    """Get the count of remaining string keys (for testing/monitoring)."""
    if not redis_client:
        redis_client = await get_redis_conn()

    remaining = await redis_client.get(MIGRATION_REMAINING_KEY)
    if remaining:
        if isinstance(remaining, bytes):
            remaining = remaining.decode("utf-8")
        return int(remaining)
    return 0


async def reset_migration_status(redis_client: Redis | None = None) -> None:
    """Reset migration status (for testing purposes)."""
    if not redis_client:
        redis_client = await get_redis_conn()

    await redis_client.delete(MIGRATION_STATUS_KEY, MIGRATION_REMAINING_KEY)


async def set_migration_complete(redis_client: Redis | None = None) -> None:
    """Mark migration as complete (called by migration script)."""
    if not redis_client:
        redis_client = await get_redis_conn()

    await redis_client.set(MIGRATION_STATUS_KEY, "true")
    await redis_client.delete(MIGRATION_REMAINING_KEY)
    logger.info("Working memory migration marked as complete.")


async def cleanup_deprecated_sessions_zsets(
    redis_client: Redis | None = None,
) -> int:
    """Delete legacy sessions sorted sets replaced by the working memory index."""
    if not redis_client:
        redis_client = await get_redis_conn()

    deleted_keys = 0

    root_key = "sessions"
    root_type = await redis_client.type(root_key)
    if isinstance(root_type, bytes):
        root_type = root_type.decode("utf-8")
    if root_type == "zset":
        deleted_keys += await redis_client.delete(root_key)

    cursor = 0
    while True:
        cursor, keys = await redis_client.scan(
            cursor=cursor,
            match="sessions:*",
            count=1000,
            _type="zset",
        )

        if keys:
            deleted_keys += await redis_client.delete(*keys)

        if cursor == 0:
            break

    if deleted_keys > 0:
        logger.info("Deleted %d deprecated sessions sorted set key(s)", deleted_keys)

    return deleted_keys


async def _migrate_string_to_json(
    redis_client: Redis,
    key: str,
    string_data: str,
) -> dict:
    """
    Migrate working memory from old string format to new JSON format.

    Args:
        redis_client: Redis client
        key: The Redis key
        string_data: The JSON string data from the old format

    Returns:
        The parsed dict data
    """
    try:
        data = json.loads(string_data)
        logger.info(f"Migrating working memory key {key} from string to JSON format")

        # Atomically migrate the key from string to JSON using a Lua script
        # The script: get TTL, get value, delete, set as JSON, restore TTL if > 0
        lua_script = """
        local key = KEYS[1]
        if redis.call('TYPE', key).ok == 'string' then
            local ttl = redis.call('TTL', key)
            local val = redis.call('GET', key)
            redis.call('DEL', key)
            redis.call('JSON.SET', key, '$', ARGV[1])
            if ttl > 0 then
                redis.call('EXPIRE', key, ttl)
            end
            return val
        else
            return nil
        end
        """
        # Pass the JSON string as ARGV[1]
        await redis_client.eval(lua_script, 1, key, json.dumps(data))

        logger.info(f"Successfully migrated working memory key {key} to JSON format")

        # Atomically decrement the remaining counter
        await _decrement_remaining_count(redis_client)

        return data
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse string data for key {key}: {e}")
        raise
    except Exception as e:
        logger.error(f"Failed to migrate working memory key {key}: {e}")
        raise


async def list_sessions(
    redis: Redis,
    limit: int = 10,
    offset: int = 0,
    namespace: str | None = None,
    user_id: str | None = None,
    project_id: str | None = None,
    agent_id: str | None = None,
) -> tuple[int, list[str]]:
    """
    List sessions using Redis Search index.

    Uses RedisVL FilterQuery on the working memory index to list sessions.
    This approach ensures that expired sessions (via TTL) are automatically
    excluded since Redis Search removes deleted keys from the index.

    Args:
        redis: Redis client
        limit: Maximum number of sessions to return
        offset: Offset for pagination
        namespace: Optional namespace filter
        user_id: Optional user ID filter

    Returns:
        Tuple of (total_count, session_ids)
    """
    from agent_memory_server.working_memory_index import get_working_memory_index

    try:
        # Get the search index
        index = await get_working_memory_index(redis)

        # Old shared JSON records used null or missing owner fields. Querying
        # only for the new shared sentinel would hide those records. Page over
        # namespace candidates, then check each stored record so old and new
        # shared values are handled the same without exposing private sessions.
        filter_expression = Tag("namespace") == namespace if namespace else None
        page_size = MAX_WORKING_MEMORY_RESOLUTION_CANDIDATES
        candidate_offset = 0
        candidate_total: int | None = None
        matched_total = 0
        session_ids: list[str] = []

        while candidate_total is None or candidate_offset < candidate_total:
            filter_query = FilterQuery(
                filter_expression=filter_expression,
                return_fields=["session_id"],
                num_results=page_size,
            ).paging(candidate_offset, page_size)
            raw_results = await index.search(filter_query)
            docs = getattr(raw_results, "docs", raw_results) or []
            if candidate_total is None:
                candidate_total = int(getattr(raw_results, "total", len(docs)))
            if not docs:
                break

            for doc in docs:
                doc_key = getattr(doc, "id", None)
                if doc_key is None and isinstance(doc, dict):
                    doc_key = doc.get("id")
                if not doc_key:
                    continue
                if isinstance(doc_key, bytes):
                    doc_key = doc_key.decode("utf-8")

                data = await redis.json().get(doc_key)
                if not data:
                    continue
                stored_session_id = data.get("session_id")
                if not isinstance(stored_session_id, str):
                    continue
                if not _working_memory_data_matches_scopes(
                    data,
                    user_id,
                    project_id,
                    agent_id,
                    namespace,
                    stored_session_id,
                ):
                    continue

                if matched_total >= offset and len(session_ids) < limit:
                    session_ids.append(stored_session_id)
                matched_total += 1

            candidate_offset += len(docs)

        return matched_total, session_ids

    except Exception as e:
        logger.error(f"Error listing sessions: {e}")
        # Return empty results on error
        return 0, []


async def _resolve_working_memory_key_via_index(
    redis_client: Redis,
    session_id: str,
    user_id: str | None = None,
    namespace: str | None = None,
    project_id: str | None = None,
    agent_id: str | None = None,
) -> str | None:
    """
    Resolve the actual Redis key for a working memory session using the search index.

    When a direct key lookup fails (e.g. because user_id/namespace were provided
    during PUT but omitted during GET), this function queries the search index
    by session_id to find the document and derive the correct Redis key.

    If multiple sessions share the same session_id (different namespace/user_id)
    and the caller did not supply enough filters to disambiguate, the function
    logs a warning and returns ``None`` to avoid silently returning the wrong
    session.

    Args:
        redis_client: Redis client
        session_id: The session ID to look up
        user_id: Optional user_id filter (narrows results if multiple sessions
            share an ID)
        namespace: Optional namespace filter

    Returns:
        The Redis key string if exactly one match is found, None otherwise
    """

    from agent_memory_server.working_memory_index import get_working_memory_index

    try:
        index = await get_working_memory_index(redis_client)

        filter_expression = Tag("session_id") == session_id
        if namespace:
            filter_expression &= Tag("namespace") == namespace
        if user_id:
            filter_expression &= Tag("user_id") == user_id
        # Project and agent are checked against the stored JSON below. Keeping
        # them out of the Redis filter lets legacy documents with missing scope
        # fields remain readable when they are shared at those dimensions.
        filter_query = FilterQuery(
            filter_expression=filter_expression,
            return_fields=["session_id"],
            num_results=MAX_WORKING_MEMORY_RESOLUTION_CANDIDATES,
        )

        raw_results = await index.search(filter_query)
        docs = getattr(raw_results, "docs", raw_results) or []

        if not docs:
            return None

        total = getattr(raw_results, "total", len(docs))
        if total > len(docs):
            logger.warning(
                "Ambiguous working-memory lookup for session_id=%s: "
                "%d sessions exceeded the safe resolution limit. "
                "Provide namespace and scope IDs to disambiguate.",
                session_id,
                total,
            )
            return None

        matching_keys = []
        for doc in docs:
            # RedisVL returns doc.id as the full Redis key.
            doc_key = getattr(doc, "id", None)
            if doc_key is None and isinstance(doc, dict):
                doc_key = doc.get("id")
            if not doc_key:
                continue
            if isinstance(doc_key, bytes):
                doc_key = doc_key.decode("utf-8")

            data = await redis_client.json().get(doc_key)
            if data and _working_memory_data_matches_scopes(
                data,
                user_id,
                project_id,
                agent_id,
                namespace,
                session_id,
            ):
                matching_keys.append(doc_key)
                if len(matching_keys) > 1:
                    break

        if len(matching_keys) == 1:
            return matching_keys[0]
        if len(matching_keys) > 1:
            logger.warning(
                "Ambiguous working-memory lookup for session_id=%s: "
                "multiple sessions matched the requested shared/private scopes.",
                session_id,
            )

        return None

    except Exception as e:
        logger.debug(f"Index-based key resolution failed for session {session_id}: {e}")
        return None


async def get_working_memory(
    session_id: str,
    user_id: str | None = None,
    namespace: str | None = None,
    project_id: str | None = None,
    agent_id: str | None = None,
    redis_client: Redis | None = None,
    recent_messages_limit: int | None = None,
) -> WorkingMemory | None:
    """
    Get working memory for a session.

    If no working memory exists but index_all_messages_in_long_term_memory is enabled,
    attempts to reconstruct working memory from messages stored in long-term memory.

    Args:
        session_id: The session ID
        namespace: Optional namespace for the session
        redis_client: Optional Redis client
        recent_messages_limit: Optional limit on number of recent messages to return

    Returns:
        WorkingMemory object or None if not found
    """
    from agent_memory_server.config import settings

    if not redis_client:
        redis_client = await get_redis_conn()

    key = Keys.working_memory_key(
        session_id=session_id,
        user_id=user_id,
        namespace=namespace,
        project_id=project_id,
        agent_id=agent_id,
    )

    try:
        working_memory_data = None

        # Check migration status (uses Redis, shared across workers)
        migration_complete = await is_migration_complete(redis_client)

        candidate_keys = [key]
        if project_id is None and agent_id is None:
            legacy_key = Keys.legacy_working_memory_key(
                session_id=session_id,
                user_id=user_id,
                namespace=namespace,
            )
            if legacy_key != key:
                candidate_keys.append(legacy_key)

        for candidate_key in candidate_keys:
            if migration_complete:
                # Fast path: all keys are already in JSON format
                candidate_data = await redis_client.json().get(candidate_key)
            else:
                # Slow path: check key type to determine storage format
                candidate_data = None
                key_type = await redis_client.type(candidate_key)
                if isinstance(key_type, bytes):
                    key_type = key_type.decode("utf-8")

                if key_type == "ReJSON-RL":
                    candidate_data = await redis_client.json().get(candidate_key)
                elif key_type == "string":
                    string_data = await redis_client.get(candidate_key)
                    if string_data:
                        if isinstance(string_data, bytes):
                            string_data = string_data.decode("utf-8")
                        candidate_data = await _migrate_string_to_json(
                            redis_client, candidate_key, string_data
                        )

            if candidate_data and _working_memory_data_matches_scopes(
                candidate_data,
                user_id,
                project_id,
                agent_id,
                namespace,
                session_id,
            ):
                key = candidate_key
                working_memory_data = candidate_data
                break
            # If key_type is "none", the key doesn't exist - working_memory_data stays None

        # Fallback: if direct key lookup failed, try resolving via the search
        # index.  This handles the case where PUT stored with user_id/namespace
        # but GET was called without them (issue #235).
        if not working_memory_data:
            resolved_key = await _resolve_working_memory_key_via_index(
                redis_client,
                session_id,
                user_id,
                namespace,
                project_id,
                agent_id,
            )
            if resolved_key and resolved_key != key:
                logger.debug(
                    f"Resolved working memory key via index: {resolved_key} "
                    f"(original key: {key})"
                )
                key = resolved_key
                working_memory_data = await redis_client.json().get(key)

        if not working_memory_data:
            logger.debug(
                f"No working memory found for parameters: {session_id}, {user_id}, {namespace}"
            )

            # Try to reconstruct from long-term memory if enabled
            if settings.index_all_messages_in_long_term_memory:
                reconstructed = await _reconstruct_working_memory_from_long_term(
                    session_id=session_id,
                    user_id=user_id,
                    namespace=namespace,
                    project_id=project_id,
                    agent_id=agent_id,
                    recent_messages_limit=recent_messages_limit,
                )
                if reconstructed:
                    logger.info(
                        f"Reconstructed working memory for session {session_id} from long-term storage"
                    )
                    return reconstructed

            return None

        # Convert memory records back to MemoryRecord objects
        memories = []
        for memory_data in working_memory_data.get("memories", []):
            memory = MemoryRecord(**memory_data)
            memories.append(memory)

        # Convert messages back to MemoryMessage objects
        messages = []
        for message_data in working_memory_data.get("messages", []):
            message = MemoryMessage(**message_data)
            messages.append(message)

        # Apply recent messages limit if specified (in-memory slice)
        if recent_messages_limit is not None and recent_messages_limit > 0:
            # Sort messages by created_at timestamp to ensure proper chronological order
            messages.sort(key=lambda m: m.created_at)
            # Get the most recent N messages
            messages = messages[-recent_messages_limit:]

        # Handle memory strategy configuration
        strategy_data = working_memory_data.get("long_term_memory_strategy")
        if strategy_data:
            long_term_memory_strategy = MemoryStrategyConfig(**strategy_data)
        else:
            long_term_memory_strategy = (
                MemoryStrategyConfig()
            )  # Default to discrete strategy

        # Use stored values for namespace/user_id — the caller may not have
        # provided them (index-fallback path, issue #235).
        stored_namespace = working_memory_data.get("namespace") or namespace
        stored_user_id = decode_scope(working_memory_data.get("user_id")) or user_id
        stored_project_id = (
            decode_scope(working_memory_data.get("project_id")) or project_id
        )
        stored_agent_id = decode_scope(working_memory_data.get("agent_id")) or agent_id

        return WorkingMemory(
            messages=messages,
            memories=memories,
            context=working_memory_data.get("context"),
            user_id=stored_user_id,
            project_id=stored_project_id,
            agent_id=stored_agent_id,
            tokens=working_memory_data.get("tokens", 0),
            session_id=session_id,
            namespace=stored_namespace,
            ttl_seconds=working_memory_data.get("ttl_seconds", None),
            data=working_memory_data.get("data") or {},
            long_term_memory_strategy=long_term_memory_strategy,
            last_accessed=datetime.fromtimestamp(
                working_memory_data.get("last_accessed", int(time.time())), UTC
            ),
            created_at=datetime.fromtimestamp(
                working_memory_data.get("created_at", int(time.time())), UTC
            ),
            updated_at=datetime.fromtimestamp(
                working_memory_data.get("updated_at", int(time.time())), UTC
            ),
        )

    except Exception as e:
        logger.error(f"Error getting working memory for session {session_id}: {e}")
        return None


async def set_working_memory(
    working_memory: WorkingMemory,
    redis_client: Redis | None = None,
) -> None:
    """
    Set working memory for a session with TTL.

    Args:
        working_memory: WorkingMemory object to store
        redis_client: Optional Redis client
    """
    if not redis_client:
        redis_client = await get_redis_conn()

    # Validate that all memories have id (Stage 3 requirement)
    for memory in working_memory.memories:
        if not memory.id:
            raise ValueError("All memory records in working memory must have an ID")

    key = Keys.working_memory_key(
        session_id=working_memory.session_id,
        user_id=working_memory.user_id,
        namespace=working_memory.namespace,
        project_id=working_memory.project_id,
        agent_id=working_memory.agent_id,
    )
    legacy_key = Keys.legacy_working_memory_key(
        session_id=working_memory.session_id,
        user_id=working_memory.user_id,
        namespace=working_memory.namespace,
    )

    # Update the updated_at timestamp
    working_memory.updated_at = datetime.now(UTC)

    # Convert to JSON-serializable format with timestamp conversion
    data = {
        "messages": [
            message.model_dump(mode="json") for message in working_memory.messages
        ],
        "memories": [
            memory.model_dump(mode="json") for memory in working_memory.memories
        ],
        "context": working_memory.context,
        "user_id": encode_scope(working_memory.user_id),
        "project_id": encode_scope(working_memory.project_id),
        "agent_id": encode_scope(working_memory.agent_id),
        "tokens": working_memory.tokens,
        "session_id": working_memory.session_id,
        "namespace": working_memory.namespace,
        "ttl_seconds": working_memory.ttl_seconds,
        "data": working_memory.data or {},
        "long_term_memory_strategy": working_memory.long_term_memory_strategy.model_dump(),
        "last_accessed": int(working_memory.last_accessed.timestamp()),
        "created_at": int(working_memory.created_at.timestamp()),
        "updated_at": int(working_memory.updated_at.timestamp()),
    }

    try:
        # Use Redis native JSON storage
        # The working memory search index automatically indexes this document
        # for session listing.
        await redis_client.json().set(key, "$", data)

        if working_memory.ttl_seconds is not None:
            # Set TTL separately for JSON keys
            await redis_client.expire(key, working_memory.ttl_seconds)
            logger.info(
                f"Set working memory for session {working_memory.session_id} with TTL {working_memory.ttl_seconds}s"
            )
        else:
            logger.info(
                f"Set working memory for session {working_memory.session_id} with no TTL"
            )

        # A compatibility read can load the old key shape, after which this write
        # stores the same session under the V1 scope-safe key. Remove the stale
        # source only after the replacement (and its TTL) has been stored so a
        # later delete cannot expose the old copy through compatibility fallback.
        if legacy_key != key:
            legacy_data = await _read_working_memory_data(redis_client, legacy_key)
            if legacy_data and _working_memory_data_matches_scopes(
                legacy_data,
                working_memory.user_id,
                working_memory.project_id,
                working_memory.agent_id,
                working_memory.namespace,
                working_memory.session_id,
            ):
                await redis_client.delete(legacy_key)
    except Exception as e:
        logger.error(
            f"Error setting working memory for session {working_memory.session_id}: {e}"
        )
        raise


async def delete_working_memory(
    session_id: str,
    user_id: str | None = None,
    namespace: str | None = None,
    project_id: str | None = None,
    agent_id: str | None = None,
    redis_client: Redis | None = None,
) -> None:
    """
    Delete working memory for a session.

    Args:
        session_id: The session ID
        user_id: Optional user ID for the session
        namespace: Optional namespace for the session
        redis_client: Optional Redis client
    """
    if not redis_client:
        redis_client = await get_redis_conn()

    key = Keys.working_memory_key(
        session_id=session_id,
        user_id=user_id,
        namespace=namespace,
        project_id=project_id,
        agent_id=agent_id,
    )

    try:
        # Check if the key exists; if not, try resolving via the search index
        # (same fallback as get_working_memory for issue #235).
        exists = await redis_client.exists(key)
        if not exists and project_id is None and agent_id is None:
            legacy_key = Keys.legacy_working_memory_key(
                session_id=session_id,
                user_id=user_id,
                namespace=namespace,
            )
            legacy_data = await _read_working_memory_data(redis_client, legacy_key)
            if legacy_data and _working_memory_data_matches_scopes(
                legacy_data,
                user_id,
                project_id,
                agent_id,
                namespace,
                session_id,
            ):
                key = legacy_key
                exists = True
        if not exists:
            resolved_key = await _resolve_working_memory_key_via_index(
                redis_client,
                session_id,
                user_id,
                namespace,
                project_id,
                agent_id,
            )
            if resolved_key:
                key = resolved_key

        # Delete the JSON key - the working memory search index automatically
        # removes the document from the index when the key is deleted
        await redis_client.delete(key)

        logger.info(f"Deleted working memory for session {session_id}")

    except Exception as e:
        logger.error(f"Error deleting working memory for session {session_id}: {e}")
        raise


async def _reconstruct_working_memory_from_long_term(
    session_id: str,
    user_id: str | None = None,
    namespace: str | None = None,
    project_id: str | None = None,
    agent_id: str | None = None,
    recent_messages_limit: int | None = None,
) -> WorkingMemory | None:
    """
    Reconstruct working memory from messages stored in long-term memory.

    This function searches for messages in long-term memory that belong to the
    specified session and reconstructs a WorkingMemory object from them.

    Args:
        session_id: The session ID to reconstruct
        user_id: Optional user ID filter
        namespace: Optional namespace filter
        recent_messages_limit: Optional limit on number of recent messages to return

    Returns:
        Reconstructed WorkingMemory object or None if no messages found
    """
    from agent_memory_server.filters import (
        AgentId,
        MemoryType,
        Namespace,
        ProjectId,
        SessionId,
        UserId,
    )
    from agent_memory_server.long_term_memory import search_long_term_memories

    try:
        # Search for message-type memories for this session
        session_filter = SessionId(eq=session_id)
        user_filter = UserId(eq=encode_scope(user_id))
        project_filter = ProjectId(eq=encode_scope(project_id))
        agent_filter = AgentId(eq=encode_scope(agent_id))
        namespace_filter = Namespace(eq=namespace) if namespace else None
        memory_type_filter = MemoryType(eq="message")

        # Search for messages with appropriate limit
        # We use empty text since we're filtering by session_id and memory_type
        search_limit = recent_messages_limit if recent_messages_limit else 1000
        results = await search_long_term_memories(
            text="",  # Empty query since we're filtering by metadata
            session_id=session_filter,
            user_id=user_filter,
            project_id=project_filter,
            agent_id=agent_filter,
            namespace=namespace_filter,
            memory_type=memory_type_filter,
            limit=search_limit,
            offset=0,
        )

        if not results.memories:
            logger.debug(
                f"No message memories found for session {session_id} in long-term storage"
            )
            return None

        # Convert memory records back to messages
        messages = []
        for memory in results.memories:
            # Parse the message text which should be in format "role: content"
            text = memory.text
            if ": " in text:
                role, content = text.split(": ", 1)
                message = MemoryMessage(
                    id=memory.id,
                    role=role.lower(),
                    content=content,
                    created_at=memory.created_at,  # Use the original creation time
                    persisted_at=memory.persisted_at,  # Mark as already persisted
                )
                messages.append(message)
            else:
                logger.warning(
                    f"Skipping malformed message memory: {memory.id} - {text}"
                )

        if not messages:
            logger.debug(f"No valid messages found for session {session_id}")
            return None

        # Sort messages by creation time to maintain conversation order (most recent first for API response)
        messages.sort(key=lambda m: m.created_at, reverse=True)

        # If we have a limit, take only the most recent N messages
        if recent_messages_limit and len(messages) > recent_messages_limit:
            messages = messages[:recent_messages_limit]

        # Reverse back to chronological order for working memory (oldest first)
        messages.reverse()

        # Create reconstructed working memory
        now = datetime.now(UTC)
        reconstructed = WorkingMemory(
            session_id=session_id,
            namespace=namespace,
            user_id=user_id,
            project_id=project_id,
            agent_id=agent_id,
            messages=messages,
            memories=[],  # No structured memories in reconstruction
            context="",  # No context in reconstruction
            data={},  # No session data in reconstruction
            created_at=messages[0].persisted_at or now if messages else now,
            updated_at=now,
            last_accessed=now,
        )

        logger.info(
            f"Reconstructed working memory for session {session_id} with {len(messages)} messages"
        )
        return reconstructed

    except Exception as e:
        logger.error(
            f"Error reconstructing working memory for session {session_id}: {e}"
        )
        return None
