"""
Simplest possible migrations you could have.
"""

import ulid
from redis.asyncio import Redis

from agent_memory_server.logging import get_logger
from agent_memory_server.scopes import SHARED_SCOPE, decode_scope
from agent_memory_server.utils.keys import Keys
from agent_memory_server.utils.recency import generate_memory_hash_from_fields
from agent_memory_server.utils.redis import get_redis_conn
from agent_memory_server.utils.tag_codec import decode_tag_values, encode_tag_values


logger = get_logger(__name__)

SHARED_SCOPE_VALUE = SHARED_SCOPE
_SCOPE_HASH_FIELDS = (
    "text",
    "project_id",
    "user_id",
    "agent_id",
    "session_id",
    "namespace",
    "memory_type",
    "memory_hash",
)
_COMPARE_AND_SET_SCOPE_FIELDS = """
local fields = {
    'text', 'project_id', 'user_id', 'agent_id',
    'session_id', 'namespace', 'memory_type', 'memory_hash'
}
local position = 1
for _, field in ipairs(fields) do
    local expected_exists = ARGV[position] == '1'
    local expected_value = ARGV[position + 1]
    local actual_value = redis.call('HGET', KEYS[1], field)
    if expected_exists then
        if actual_value ~= expected_value then
            return 0
        end
    elseif actual_value ~= false then
        return 0
    end
    position = position + 2
end

local update_count = tonumber(ARGV[position])
position = position + 1
for _ = 1, update_count do
    redis.call('HSET', KEYS[1], ARGV[position], ARGV[position + 1])
    position = position + 2
end
return 1
"""


async def _update_scope_fields_if_unchanged(
    redis: Redis,
    key: str | bytes,
    snapshot: dict[str, str],
    updates: dict[str, str],
) -> bool:
    """Apply a migration update only while its source fields are unchanged."""
    expected: list[str] = []
    for field in _SCOPE_HASH_FIELDS:
        expected.extend(["1", snapshot[field]] if field in snapshot else ["0", ""])

    update_args = [item for pair in updates.items() for item in pair]
    changed = await redis.eval(
        _COMPARE_AND_SET_SCOPE_FIELDS,
        1,
        key,
        *expected,
        str(len(updates)),
        *update_args,
    )
    return bool(changed)


async def migrate_add_memory_hashes_1(redis: Redis | None = None) -> None:
    """
    Migration 1: Add memory_hash to all existing memories in Redis
    """
    logger.info("Starting memory hash migration")
    redis = redis or await get_redis_conn()

    # 1. Scan Redis for all memory keys
    memory_keys = []
    cursor = 0

    pattern = Keys.memory_key("*")

    while True:
        cursor, keys = await redis.scan(cursor=cursor, match=pattern, count=100)
        memory_keys.extend(keys)
        if cursor == 0:
            break

    if not memory_keys:
        logger.info("No memories found to migrate")
        return

    # 2. Process memories in batches
    batch_size = 50
    migrated_count = 0

    for i in range(0, len(memory_keys), batch_size):
        batch_keys = memory_keys[i : i + batch_size]
        pipeline = redis.pipeline()

        # First get the data
        for key in batch_keys:
            pipeline.hgetall(key)

        results = await pipeline.execute()

        # Now update with hashes
        update_pipeline = redis.pipeline()
        for j, result in enumerate(results):
            if not result:
                continue

            # Convert bytes to strings
            try:
                memory = {
                    k.decode() if isinstance(k, bytes) else k: v.decode()
                    if isinstance(v, bytes)
                    else v
                    for k, v in result.items()
                    if k
                    in (
                        b"text",
                        b"project_id",
                        b"user_id",
                        b"agent_id",
                        b"session_id",
                        b"namespace",
                        b"memory_type",
                        b"memory_hash",
                    )
                }
            except Exception as e:
                logger.error(f"Error decoding memory: {result}, {e}")
                continue

            if not memory or "memory_hash" in memory:
                continue

            memory_hash = generate_memory_hash_from_fields(
                text=memory.get("text", ""),
                project_id=decode_scope(memory.get("project_id")),
                user_id=decode_scope(memory.get("user_id")),
                agent_id=decode_scope(memory.get("agent_id")),
                session_id=decode_scope(memory.get("session_id")),
                namespace=memory.get("namespace") or None,
                memory_type=memory.get("memory_type") or "message",
            )

            update_pipeline.hset(batch_keys[j], mapping={"memory_hash": memory_hash})
            migrated_count += 1

        await update_pipeline.execute()
        logger.info(f"Migrated {migrated_count} memories so far")

    logger.info(f"Migration completed. Added hashes to {migrated_count} memories")


async def migrate_add_discrete_memory_extracted_2(redis: Redis | None = None) -> None:
    """
    Migration 2: Add discrete_memory_extracted to all existing memories in Redis
    """
    logger.info("Starting discrete_memory_extracted migration")
    redis = redis or await get_redis_conn()

    keys = await redis.keys(Keys.memory_key("*"))

    migrated_count = 0
    for key in keys:
        id_ = await redis.hget(name=key, key="id_")  # type: ignore
        if not id_:
            logger.info("Updating memory with no ID to set ID")
            await redis.hset(name=key, key="id_", value=str(ulid.ULID()))  # type: ignore
        extracted: bytes | None = await redis.hget(
            name=key, key="discrete_memory_extracted"
        )  # type: ignore
        if extracted:
            continue
        await redis.hset(  # type: ignore
            name=key, key="discrete_memory_extracted", value="f"
        )
        migrated_count += 1

    logger.info(
        f"Migration completed. Added discrete_memory_extracted (f) to {migrated_count} memories"
    )


async def migrate_add_memory_type_3(redis: Redis | None = None) -> None:
    """
    Migration 3: Add memory_type to all existing memories in Redis
    """
    logger.info("Starting memory_type migration")
    redis = redis or await get_redis_conn()

    keys = await redis.keys(Keys.memory_key("*"))

    migrated_count = 0
    for key in keys:
        id_ = await redis.hget(name=key, key="id_")  # type: ignore
        if not id_:
            logger.info("Updating memory with no ID to set ID")
            await redis.hset(name=key, key="id_", value=str(ulid.ULID()))  # type: ignore
        memory_type: bytes | None = await redis.hget(name=key, key="memory_type")  # type: ignore
        if not memory_type:
            await redis.hset(name=key, key="memory_type", value="message")  # type: ignore
        migrated_count += 1

    logger.info(f"Migration completed. Added memory_type to {migrated_count} memories")


async def migrate_normalize_tag_separators_4(redis: Redis | None = None) -> None:
    """
    Migration 4: Normalize long-term memory TAG fields to comma separators.

    This rewrites legacy pipe-delimited values in list-backed TAG fields so the
    stored hash values match the canonical RedisVL schema configuration.
    """
    logger.info("Starting TAG separator normalization migration")
    redis = redis or await get_redis_conn()

    cursor = 0
    batch_size = 50
    normalized_count = 0
    pattern = Keys.memory_key("*")

    while True:
        cursor, keys = await redis.scan(cursor=cursor, match=pattern, count=batch_size)

        if keys:
            read_pipeline = redis.pipeline(transaction=False)
            for key in keys:
                read_pipeline.hgetall(key)

            results = await read_pipeline.execute()

            write_pipeline = redis.pipeline(transaction=False)
            pending_updates = 0

            for key, result in zip(keys, results, strict=False):
                if not result:
                    continue

                try:
                    decoded_result = {
                        k.decode() if isinstance(k, bytes) else k: v.decode()
                        if isinstance(v, bytes)
                        else v
                        for k, v in result.items()
                    }
                except Exception as e:
                    logger.error(f"Error decoding memory during TAG migration: {e}")
                    continue

                field_updates: dict[str, str] = {}
                for field in ("topics", "entities", "extracted_from"):
                    if field not in decoded_result:
                        continue

                    current_value = decoded_result.get(field) or ""
                    normalized_value = encode_tag_values(
                        decode_tag_values(current_value)
                    )

                    if normalized_value != current_value:
                        field_updates[field] = normalized_value

                if field_updates:
                    write_pipeline.hset(key, mapping=field_updates)
                    pending_updates += 1
                    normalized_count += 1

            if pending_updates:
                await write_pipeline.execute()

        if cursor == 0:
            break

    logger.info(
        f"Migration completed. Normalized TAG separators for {normalized_count} memories"
    )


async def migrate_add_scope_fields_5(redis: Redis | None = None) -> None:
    """
    Migration 5: Add indexed shared scopes to legacy memories.

    Redis TAG fields do not index empty values. Missing and empty private scope
    fields therefore use an explicit sentinel. Hashes are rebuilt because
    project and agent are now part of the deduplication boundary.
    """
    logger.info("Starting project and agent scope migration")
    redis = redis or await get_redis_conn()

    cursor = 0
    batch_size = 50
    migrated_count = 0
    pattern = Keys.memory_key("*")

    while True:
        cursor, keys = await redis.scan(cursor=cursor, match=pattern, count=batch_size)

        if keys:
            read_pipeline = redis.pipeline(transaction=False)
            for key in keys:
                read_pipeline.hgetall(key)

            results = await read_pipeline.execute()

            for key, result in zip(keys, results, strict=False):
                if not result:
                    continue

                relevant_fields = {
                    "text",
                    "project_id",
                    "user_id",
                    "agent_id",
                    "session_id",
                    "namespace",
                    "memory_type",
                    "memory_hash",
                }
                decoded_result = {}
                for raw_key, raw_value in result.items():
                    field = raw_key.decode() if isinstance(raw_key, bytes) else raw_key
                    if field not in relevant_fields:
                        continue
                    decoded_result[field] = (
                        raw_value.decode()
                        if isinstance(raw_value, bytes)
                        else raw_value
                    )
                field_updates: dict[str, str] = {}
                for field in ("project_id", "user_id", "agent_id", "session_id"):
                    current_value = decoded_result.get(field)

                    if current_value in (None, ""):
                        field_updates[field] = SHARED_SCOPE_VALUE

                normalized = {**decoded_result, **field_updates}
                memory_hash = generate_memory_hash_from_fields(
                    text=normalized.get("text", ""),
                    project_id=decode_scope(normalized.get("project_id")),
                    user_id=decode_scope(normalized.get("user_id")),
                    agent_id=decode_scope(normalized.get("agent_id")),
                    session_id=decode_scope(normalized.get("session_id")),
                    namespace=normalized.get("namespace") or None,
                    memory_type=normalized.get("memory_type") or "message",
                )
                if decoded_result.get("memory_hash") != memory_hash:
                    field_updates["memory_hash"] = memory_hash

                if field_updates:
                    changed = await _update_scope_fields_if_unchanged(
                        redis,
                        key,
                        decoded_result,
                        field_updates,
                    )
                    migrated_count += int(changed)

        if cursor == 0:
            break

    logger.info(
        f"Migration completed. Added shared scope fields to {migrated_count} memories"
    )
