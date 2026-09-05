from datetime import UTC, datetime, timedelta

from agent_memory_server.long_term_memory import (
    select_ids_for_forgetting,
)
from agent_memory_server.models import MemoryRecordResult, MemoryTypeEnum
from agent_memory_server.utils.recency import (
    rerank_with_recency,
    score_recency,
)


def make_result(
    id: str,
    text: str,
    dist: float,
    created_days_ago: int,
    accessed_days_ago: int,
    user_id: str | None = "u1",
    namespace: str | None = "ns1",
):
    now = datetime.now(UTC)
    return MemoryRecordResult(
        id=id,
        text=text,
        dist=dist,
        created_at=now - timedelta(days=created_days_ago),
        updated_at=now - timedelta(days=created_days_ago),
        last_accessed=now - timedelta(days=accessed_days_ago),
        user_id=user_id,
        session_id=None,
        namespace=namespace,
        topics=[],
        entities=[],
        memory_hash="",
        memory_type=MemoryTypeEnum.SEMANTIC,
        persisted_at=None,
        extracted_from=[],
        event_date=None,
    )


def default_params():
    return {
        "semantic_weight": 0.8,
        "recency_weight": 0.2,
        "freshness_weight": 0.6,
        "novelty_weight": 0.4,
        "half_life_last_access_days": 7.0,
        "half_life_created_days": 30.0,
    }


def test_score_recency_monotonicity_with_age():
    params = default_params()
    now = datetime.now(UTC)

    newer = make_result("a", "new", dist=0.5, created_days_ago=1, accessed_days_ago=1)
    older = make_result("b", "old", dist=0.5, created_days_ago=60, accessed_days_ago=60)

    r_new = score_recency(newer, now=now, params=params)
    r_old = score_recency(older, now=now, params=params)

    assert 0.0 <= r_new <= 1.0
    assert 0.0 <= r_old <= 1.0
    assert r_new > r_old


def test_rerank_with_recency_prefers_recent_when_similarity_close():
    params = default_params()
    now = datetime.now(UTC)

    # More similar but old
    old_more_sim = make_result(
        "old", "old", dist=0.05, created_days_ago=45, accessed_days_ago=45
    )
    # Less similar but fresh
    fresh_less_sim = make_result(
        "fresh", "fresh", dist=0.25, created_days_ago=0, accessed_days_ago=0
    )

    ranked = rerank_with_recency([old_more_sim, fresh_less_sim], now=now, params=params)

    # With the default modest recency weight, freshness should win when similarity is close
    assert ranked[0].id == "fresh"
    assert ranked[1].id == "old"


def test_pinned_recency_does_not_decay_or_change_stored_memory():
    now = datetime.now(UTC)
    old = make_result("pinned", "Keep this fact", 0.2, 365, 365)
    old.pinned = True
    original = old.model_dump()
    assert score_recency(old, now=now, params=default_params()) == 1.0
    assert (
        score_recency(old, now=now + timedelta(days=365), params=default_params())
        == 1.0
    )
    assert old.model_dump() == original
    old.pinned = False
    assert score_recency(old, now=now, params=default_params()) < 0.01


def test_pinned_recency_preserves_semantic_relevance():
    now = datetime.now(UTC)
    pinned = make_result("pinned", "Weak match", 0.9, 365, 365)
    pinned.pinned = True
    relevant = make_result("relevant", "Strong match", 0.01, 365, 365)
    ranked = rerank_with_recency([pinned, relevant], now=now, params=default_params())
    assert [memory.id for memory in ranked] == ["relevant", "pinned"]


def test_read_count_boost_is_bounded_and_does_not_edit_memory():
    now = datetime.now(UTC)
    memory = make_result("read", "Example fact", 0.2, 365, 365)
    scores = []
    for count in [-1, 0, 1, 10, 100, 1000000]:
        memory.access_count = count
        original = memory.model_dump()
        scores.append(score_recency(memory, now=now, params=default_params()))
        assert memory.model_dump() == original
    assert scores[0] == scores[1]
    assert scores[1] < scores[2] < scores[3] < scores[4]
    assert scores[4] == scores[5]
    assert scores[4] - scores[1] <= 0.15
    memory.pinned = True
    assert score_recency(memory, now=now, params=default_params()) == 1.0


def test_read_count_breaks_close_matches_but_not_a_large_relevance_gap():
    now = datetime.now(UTC)
    unused = make_result("unused", "Example fact", 0.2, 30, 30)
    used = unused.model_copy(update={"id": "used", "access_count": 100})
    ranked = rerank_with_recency([unused, used], now=now, params=default_params())
    assert [memory.id for memory in ranked] == ["used", "unused"]
    used.dist = 0.9
    ranked = rerank_with_recency([used, unused], now=now, params=default_params())
    assert [memory.id for memory in ranked] == ["unused", "used"]


def test_read_count_does_not_change_cleanup_selection():
    now = datetime.now(UTC)
    recent = make_result("recent", "Example fact", 0.2, 30, 30)
    older = make_result("older", "Example fact", 0.2, 31, 31)
    older.access_count = 100
    policy = {"budget": 1}
    assert select_ids_for_forgetting([recent, older], policy=policy, now=now) == [
        "older"
    ]


def test_rerank_with_recency_respects_semantic_weight_when_gap_large():
    # If semantic similarity difference is large, it should dominate
    params = default_params()
    params["semantic_weight"] = 0.9
    params["recency_weight"] = 0.1
    now = datetime.now(UTC)

    much_more_similar_old = make_result(
        "old", "old", dist=0.01, created_days_ago=90, accessed_days_ago=90
    )
    weak_similar_fresh = make_result(
        "fresh", "fresh", dist=0.6, created_days_ago=0, accessed_days_ago=0
    )

    ranked = rerank_with_recency(
        [weak_similar_fresh, much_more_similar_old], now=now, params=params
    )
    assert ranked[0].id == "old"


def test_select_ids_for_forgetting_ttl_and_inactivity():
    now = datetime.now(UTC)
    recent = make_result(
        "keep1", "recent", dist=0.3, created_days_ago=5, accessed_days_ago=2
    )
    old_but_active = make_result(
        "keep2", "old-but-active", dist=0.3, created_days_ago=60, accessed_days_ago=1
    )
    old_and_inactive = make_result(
        "del1", "old-inactive", dist=0.3, created_days_ago=60, accessed_days_ago=45
    )
    very_old = make_result(
        "del2", "very-old", dist=0.3, created_days_ago=400, accessed_days_ago=5
    )

    policy = {
        "max_age_days": 365 / 12,  # ~30 days
        "max_inactive_days": 30,
        "budget": None,  # no budget cap in this test
        "memory_type_allowlist": None,
    }

    to_delete = select_ids_for_forgetting(
        [recent, old_but_active, old_and_inactive, very_old],
        policy=policy,
        now=now,
        pinned_ids=set(),
    )
    # Both TTL and inactivity should catch different items
    assert set(to_delete) == {"del1", "del2"}


def test_select_ids_for_forgetting_budget_keeps_top_by_recency():
    now = datetime.now(UTC)

    # Create 5 results, with varying ages
    r1 = make_result("m1", "t", dist=0.3, created_days_ago=1, accessed_days_ago=1)
    r2 = make_result("m2", "t", dist=0.3, created_days_ago=5, accessed_days_ago=5)
    r3 = make_result("m3", "t", dist=0.3, created_days_ago=10, accessed_days_ago=10)
    r4 = make_result("m4", "t", dist=0.3, created_days_ago=20, accessed_days_ago=20)
    r5 = make_result("m5", "t", dist=0.3, created_days_ago=40, accessed_days_ago=40)

    policy = {
        "max_age_days": None,
        "max_inactive_days": None,
        "budget": 2,  # keep only 2 most recent by recency score, delete the rest
        "memory_type_allowlist": None,
    }

    to_delete = select_ids_for_forgetting(
        [r1, r2, r3, r4, r5], policy=policy, now=now, pinned_ids=set()
    )

    # Expect 3 deletions: the 3 least recent are deleted
    assert len(to_delete) == 3
    # The two most recent should be kept (m1, m2), so they should NOT be in delete set
    assert "m1" not in to_delete and "m2" not in to_delete


def test_select_ids_for_forgetting_respects_pinned_ids():
    now = datetime.now(UTC)
    r1 = make_result("m1", "t", dist=0.4, created_days_ago=1, accessed_days_ago=1)
    r2 = make_result("m2", "t", dist=0.4, created_days_ago=2, accessed_days_ago=2)
    r3 = make_result("m3", "t", dist=0.4, created_days_ago=30, accessed_days_ago=30)

    policy = {
        "max_age_days": None,
        "max_inactive_days": None,
        "budget": 1,
        "memory_type_allowlist": None,
    }

    to_delete = select_ids_for_forgetting(
        [r1, r2, r3], policy=policy, now=now, pinned_ids={"m1"}
    )

    # We must keep m1 regardless of budget; so m2/m3 compete for deletion, m3 is older and should be deleted
    assert "m1" not in to_delete
    assert "m3" in to_delete
