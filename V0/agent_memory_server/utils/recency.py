"""Recency-related utilities for memory scoring and hashing."""

import hashlib
import json
from datetime import datetime
from math import exp, log

from agent_memory_server.models import MemoryRecord, MemoryRecordResult


# Seconds per day constant for time calculations
SECONDS_PER_DAY = 86400.0
ACCESS_COUNT_CAP = 100
ACCESS_COUNT_BOOST = 0.15


def generate_memory_hash(memory: MemoryRecord) -> str:
    """
    Generate a stable hash for a memory based on text, user_id, and session_id.

    Args:
        memory: MemoryRecord object containing memory data

    Returns:
        A stable hash string
    """
    # Create a deterministic string representation of the key content fields only
    # This ensures merged memories with same content have the same hash
    content_fields = {
        "text": memory.text,
        "project_id": memory.project_id,
        "user_id": memory.user_id,
        "agent_id": memory.agent_id,
        "session_id": memory.session_id,
        "namespace": memory.namespace,
        "memory_type": memory.memory_type,
    }
    content_json = json.dumps(content_fields, sort_keys=True)
    return hashlib.sha256(content_json.encode()).hexdigest()


def generate_memory_hash_from_fields(
    text: str,
    user_id: str | None,
    session_id: str | None,
    namespace: str | None,
    memory_type: str,
    project_id: str | None = None,
    agent_id: str | None = None,
) -> str:
    """
    Generate a memory hash directly from field values without creating a memory object.

    This is more efficient than creating a temporary MemoryRecord just for hashing.

    Args:
        text: Memory text content
        user_id: User ID
        session_id: Session ID
        namespace: Namespace
        memory_type: Memory type

    Returns:
        A stable hash string
    """
    content_fields = {
        "text": text,
        "project_id": project_id,
        "user_id": user_id,
        "agent_id": agent_id,
        "session_id": session_id,
        "namespace": namespace,
        "memory_type": memory_type,
    }
    content_json = json.dumps(content_fields, sort_keys=True)
    return hashlib.sha256(content_json.encode()).hexdigest()


def update_memory_hash_if_text_changed(memory: MemoryRecord, updates: dict) -> dict:
    """
    Helper function to regenerate memory hash if text field was updated.

    This avoids code duplication of the hash regeneration logic across
    different update flows (like memory creation, merging, and editing).

    Args:
        memory: The original memory record
        updates: Dictionary of updates to apply

    Returns:
        Dictionary with updated memory_hash added if text was in the updates
    """
    result_updates = dict(updates)

    hash_fields = {
        "text",
        "project_id",
        "user_id",
        "agent_id",
        "session_id",
        "namespace",
        "memory_type",
    }
    if hash_fields.intersection(updates):
        # Use efficient field-based hashing instead of creating temporary object
        result_updates["memory_hash"] = generate_memory_hash_from_fields(
            text=updates.get("text", memory.text),
            project_id=updates.get("project_id", memory.project_id),
            user_id=updates.get("user_id", memory.user_id),
            agent_id=updates.get("agent_id", memory.agent_id),
            session_id=updates.get("session_id", memory.session_id),
            namespace=updates.get("namespace", memory.namespace),
            memory_type=updates.get("memory_type", memory.memory_type),
        )

    return result_updates


def _days_between(now: datetime, then: datetime | None) -> float:
    if then is None:
        return float("inf")
    delta = now - then
    return max(delta.total_seconds() / SECONDS_PER_DAY, 0.0)


def score_recency(
    memory: MemoryRecordResult,
    *,
    now: datetime,
    params: dict,
) -> float:
    """Compute a recency score in [0, 1] combining freshness and novelty.

    - freshness decays with last_accessed using half-life `half_life_last_access_days`
    - novelty decays with created_at using half-life `half_life_created_days`
    - recency = freshness_weight * freshness + novelty_weight * novelty
    - pinned memories keep the full recency component regardless of age
    - read counts add a capped boost, not a claim that a fact is correct
    """
    if memory.pinned:
        return 1.0

    half_life_last_access = max(
        float(params.get("half_life_last_access_days", 7.0)), 0.001
    )
    half_life_created = max(float(params.get("half_life_created_days", 30.0)), 0.001)

    freshness_weight = float(params.get("freshness_weight", 0.6))
    novelty_weight = float(params.get("novelty_weight", 0.4))

    # Convert to decay rates
    access_decay_rate = log(2.0) / half_life_last_access
    creation_decay_rate = log(2.0) / half_life_created

    days_since_access = _days_between(now, memory.last_accessed)
    days_since_created = _days_between(now, memory.created_at)

    freshness = exp(-access_decay_rate * days_since_access)
    novelty = exp(-creation_decay_rate * days_since_created)

    recency_score = freshness_weight * freshness + novelty_weight * novelty
    recency_score = min(max(recency_score, 0.0), 1.0)
    count = min(max(memory.access_count, 0), ACCESS_COUNT_CAP)
    frequency = log(1 + count) / log(1 + ACCESS_COUNT_CAP)
    boost = ACCESS_COUNT_BOOST if params.get("include_access_count", True) else 0.0
    return recency_score + boost * frequency * (1.0 - recency_score)


def rerank_with_recency(
    results: list[MemoryRecordResult],
    *,
    now: datetime,
    params: dict,
) -> list[MemoryRecordResult]:
    """Re-rank results using combined semantic similarity and recency.

    score = semantic_weight * (1 - dist) + recency_weight * recency_score
    """
    semantic_weight = float(params.get("semantic_weight", 0.8))
    recency_weight = float(params.get("recency_weight", 0.2))

    def combined_score(mem: MemoryRecordResult) -> float:
        similarity = 1.0 - float(mem.dist)
        recency = score_recency(mem, now=now, params=params)
        return semantic_weight * similarity + recency_weight * recency

    # Sort by descending score (stable sort preserves original order on ties)
    return sorted(results, key=combined_score, reverse=True)
