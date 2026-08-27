"""Helpers for packing ranked memories into a caller token budget."""

from collections.abc import Callable

from agent_memory_server.models import (
    MemoryRecordResult,
    MemoryRecordResults,
)


LONG_TERM_MEMORY_PROMPT_HEADING = "## Long term memories related to the user's query"


def format_memory_for_prompt(memory: MemoryRecordResult) -> str:
    """Format one atomic memory exactly as the prompt endpoint does."""
    return f"- {memory.text} (ID: {memory.id})"


def format_memory_prompt_block(memories: list[MemoryRecordResult]) -> str:
    """Format the complete long-term-memory block emitted by memory_prompt."""
    body = "\n".join(format_memory_for_prompt(memory) for memory in memories)
    return f"{LONG_TERM_MEMORY_PROMPT_HEADING}\n {body}"


def pack_memory_results(
    candidates: MemoryRecordResults,
    *,
    max_tokens: int,
    max_results: int,
    count_tokens: Callable[[str], int],
    prefix: str = "",
) -> MemoryRecordResults:
    """Pack whole ranked memories without exceeding either safety limit."""
    if max_tokens < 1:
        raise ValueError("max_tokens must be positive")
    if max_results < 1:
        raise ValueError("max_results must be positive")

    packed: list[MemoryRecordResult] = []
    tokens_used = 0
    budget_exhausted = False

    for memory in candidates.memories:
        if len(packed) >= max_results:
            budget_exhausted = True
            break

        body = "\n".join(
            format_memory_for_prompt(candidate) for candidate in [*packed, memory]
        )
        trial = f"{prefix}\n {body}" if prefix else body
        trial_tokens = count_tokens(trial)
        if trial_tokens > max_tokens:
            budget_exhausted = True
            continue

        packed.append(memory)
        tokens_used = trial_tokens

    if candidates.next_offset is not None or candidates.total > len(
        candidates.memories
    ):
        budget_exhausted = True

    return candidates.model_copy(
        update={
            "memories": packed,
            "tokens_used": tokens_used,
            "token_budget": max_tokens,
            "budget_exhausted": budget_exhausted,
        }
    )
