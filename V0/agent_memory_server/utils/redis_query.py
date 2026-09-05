from __future__ import annotations

from typing import Any

from redis.commands.search.aggregation import Desc
from redisvl.query import AggregationQuery, RangeQuery, VectorQuery

# Import constants from utils.recency module
from agent_memory_server.utils.recency import (
    ACCESS_COUNT_BOOST,
    ACCESS_COUNT_CAP,
    SECONDS_PER_DAY,
)


class RecencyAggregationQuery(AggregationQuery):
    """AggregationQuery helper for KNN + recency boosting with APPLY/SORTBY and paging.

    Usage:
      - Build a VectorQuery or RangeQuery (hybrid filter expression allowed)
      - Call RecencyAggregationQuery.from_vector_query(...)
      - Chain .load_default_fields().apply_recency(params).sort_by_boosted_desc().paginate(offset, limit)
    """

    DEFAULT_RETURN_FIELDS = [
        "id_",
        "session_id",
        "user_id",
        "project_id",
        "agent_id",
        "namespace",
        "created_at",
        "last_accessed",
        "updated_at",
        "pinned",
        "access_count",
        "topics",
        "entities",
        "memory_hash",
        "discrete_memory_extracted",
        "memory_type",
        "extraction_strategy",
        "extraction_strategy_config",
        "metadata",
        "persisted_at",
        "extracted_from",
        "event_date",
        "text",
        VectorQuery.DISTANCE_ID,
    ]

    @classmethod
    def from_vector_query(
        cls,
        vq: VectorQuery | RangeQuery,
    ) -> RecencyAggregationQuery:
        agg = cls(vq.query_string())
        agg.dialect(2)
        return agg

    def load_default_fields(self) -> RecencyAggregationQuery:
        self.load(*self.DEFAULT_RETURN_FIELDS)
        return self

    def apply_recency(
        self, *, now_ts: int, params: dict[str, Any] | None = None
    ) -> RecencyAggregationQuery:
        params = params or {}

        semantic_weight = float(params.get("semantic_weight", 0.8))
        recency_weight = float(params.get("recency_weight", 0.2))
        freshness_weight = float(params.get("freshness_weight", 0.6))
        novelty_weight = float(params.get("novelty_weight", 0.4))
        count_boost = (
            ACCESS_COUNT_BOOST if params.get("include_access_count", True) else 0.0
        )
        half_life_access = max(
            float(params.get("half_life_last_access_days", 7.0)), 0.001
        )
        half_life_created = max(
            float(params.get("half_life_created_days", 30.0)), 0.001
        )

        self.apply(
            days_since_access=f"case(@last_accessed < {now_ts}, "
            f"({now_ts} - @last_accessed)/{SECONDS_PER_DAY}, 0)"
        )
        self.apply(
            days_since_created=f"case(@created_at < {now_ts}, "
            f"({now_ts} - @created_at)/{SECONDS_PER_DAY}, 0)"
        )
        self.apply(
            freshness=f"case(exists(@last_accessed), "
            f"exp(0 - log(2) * @days_since_access / {half_life_access}), 0)"
        )
        self.apply(
            novelty=f"exp(0 - log(2) * @days_since_created / {half_life_created})"
        )
        self.apply(
            raw_recency=f"{freshness_weight} * @freshness + {novelty_weight} * @novelty"
        )
        self.apply(
            base_recency="case(@raw_recency < 0, 0, "
            "case(@raw_recency > 1, 1, @raw_recency))"
        )
        self.apply(
            read_count="case(exists(@access_count), case(@access_count > 0, "
            f"case(@access_count > {ACCESS_COUNT_CAP}, {ACCESS_COUNT_CAP}, "
            "@access_count), 0), 0)"
        )
        self.apply(frequency=f"log(1 + @read_count) / log({1 + ACCESS_COUNT_CAP})")
        self.apply(
            recency="case(@pinned == '1', 1, @base_recency + "
            f"{count_boost} * @frequency * (1 - @base_recency))"
        )
        self.apply(sim=f"1 - (@{VectorQuery.DISTANCE_ID} / 2)")
        self.apply(
            boosted_score=f"{semantic_weight} * @sim + {recency_weight} * @recency"
        )

        return self

    def sort_by_boosted_desc(self) -> RecencyAggregationQuery:
        self.sort_by(Desc("@boosted_score"))
        return self

    def paginate(self, offset: int, limit: int) -> RecencyAggregationQuery:
        self.limit(offset, limit)
        return self

    def build_args(self) -> list:
        """Build the query arguments for Redis search."""
        return super().build_args()
