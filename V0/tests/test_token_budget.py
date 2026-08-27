from unittest.mock import patch

from agent_memory_server.api import _count_text_tokens
from agent_memory_server.models import MemoryRecordResult, MemoryRecordResults
from agent_memory_server.retrieval import pack_memory_results


def result(memory_id, text):
    return MemoryRecordResult(id=memory_id, text=text, dist=0.1)


def test_token_budget_packs_whole_memories_at_and_below_the_limit():
    candidates = MemoryRecordResults(
        memories=[result("a", "alpha beta"), result("b", "gamma delta")],
        total=2,
    )

    exact = pack_memory_results(
        candidates,
        max_tokens=10,
        max_results=10,
        count_tokens=lambda text: len(text.split()),
    )
    below = pack_memory_results(
        candidates,
        max_tokens=9,
        max_results=10,
        count_tokens=lambda text: len(text.split()),
    )

    assert [memory.id for memory in exact.memories] == ["a", "b"]
    assert exact.tokens_used == 10
    assert exact.budget_exhausted is False
    assert [memory.id for memory in below.memories] == ["a"]
    assert below.tokens_used == 5
    assert below.budget_exhausted is True


def test_token_budget_skips_an_oversized_memory_and_tries_the_next_one():
    candidates = MemoryRecordResults(
        memories=[
            result("large", "one two three four five six seven"),
            result("small", "fits"),
        ],
        total=2,
    )

    packed = pack_memory_results(
        candidates,
        max_tokens=4,
        max_results=10,
        count_tokens=lambda text: len(text.split()),
    )

    assert [memory.id for memory in packed.memories] == ["small"]
    assert packed.tokens_used == 4
    assert packed.budget_exhausted is True


def test_token_budget_uses_the_safe_character_fallback():
    candidates = MemoryRecordResults(
        memories=[result("a", "fallback token counting")],
        total=1,
    )

    with patch("agent_memory_server.api._get_tiktoken_encoding", return_value=None):
        packed = pack_memory_results(
            candidates,
            max_tokens=100,
            max_results=10,
            count_tokens=_count_text_tokens,
        )

    assert [memory.id for memory in packed.memories] == ["a"]
    assert packed.tokens_used > 0
