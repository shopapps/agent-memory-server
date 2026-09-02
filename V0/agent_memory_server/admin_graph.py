"""Read-only human memory graph and its packaged browser page."""

from collections import Counter
from hashlib import sha256
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse

from agent_memory_server import long_term_memory
from agent_memory_server.auth import UserInfo, get_current_user
from agent_memory_server.filters import AgentId, MemoryType, Namespace, ProjectId
from agent_memory_server.models import (
    MemoryGraphEdge,
    MemoryGraphFacet,
    MemoryGraphFacets,
    MemoryGraphNode,
    MemoryGraphResponse,
    MemoryRecord,
    MemoryRecordResult,
    MemoryTypeEnum,
    SearchModeEnum,
)
from agent_memory_server.namespaces import normalize_namespace
from agent_memory_server.scopes import SHARED_SCOPE


router = APIRouter()
_UI_DIRECTORY = Path(__file__).with_name("admin_ui")
_FACET_SCAN_LIMIT = 500
_MAX_NAMESPACE_NODES = 80
_MAX_TOPIC_NODES = 40
_MAX_ENTITY_NODES = 40


def _stable_id(kind: str, value: str) -> str:
    digest = sha256(f"{kind}:{value}".encode()).hexdigest()[:16]
    return f"{kind}:{digest}"


def _short_label(text: str, limit: int = 58) -> str:
    first_line = next((line.strip() for line in text.splitlines() if line.strip()), "")
    if not first_line:
        return "Untitled memory"
    if len(first_line) <= limit:
        return first_line
    return f"{first_line[: limit - 1].rstrip()}…"


def _scope_value(value: str | None) -> str:
    return value or SHARED_SCOPE


def _scope_label(value: str) -> str:
    if value == SHARED_SCOPE:
        return "Shared"
    return value.rsplit("/", maxsplit=1)[-1]


def _fallback_project_namespace(namespace: str) -> tuple[str, list[str], str]:
    """Treat the front of an old namespace as its missing project value."""

    if "/" in namespace:
        parts = namespace.split("/")
        project_end = min(2, len(parts))
        return "/".join(parts[:project_end]), parts[project_end:], "/"
    if "." in namespace:
        parts = namespace.split(".")
        return parts[0], parts[1:], "."
    return namespace, [], "/"


def _project_identity(memory: MemoryRecordResult) -> tuple[str, str, str]:
    if memory.project_id:
        return "project_id", memory.project_id, _scope_label(memory.project_id)
    if memory.namespace:
        project_namespace, _children, _separator = _fallback_project_namespace(
            memory.namespace
        )
        return "namespace", project_namespace, _scope_label(project_namespace)
    return "project_id", SHARED_SCOPE, "Shared"


def _project_separator(memory: MemoryRecordResult) -> str:
    if memory.project_id or not memory.namespace:
        return "/"
    _project_namespace, _children, separator = _fallback_project_namespace(
        memory.namespace
    )
    return separator


def _namespace_paths(memory: MemoryRecordResult) -> list[tuple[str, str]]:
    if not memory.namespace:
        return []

    if memory.project_id:
        parts = memory.namespace.split("/")
        return [
            ("/".join(parts[:end]), parts[end - 1]) for end in range(1, len(parts) + 1)
        ]

    project_namespace, child_parts, separator = _fallback_project_namespace(
        memory.namespace
    )
    return [
        (
            separator.join([project_namespace, *child_parts[:end]]),
            child_parts[end - 1],
        )
        for end in range(1, len(child_parts) + 1)
    ]


def _unique_values(values: list[str] | None) -> list[str]:
    return list(dict.fromkeys(value.strip() for value in values or [] if value.strip()))


def _top_values(counter: Counter[str], limit: int) -> set[str]:
    ordered = sorted(counter.items(), key=lambda item: (-item[1], item[0].lower()))
    return {value for value, _count in ordered[:limit]}


def _facet_list(
    counter: Counter[str], labeler=lambda value: value
) -> list[MemoryGraphFacet]:
    return [
        MemoryGraphFacet(value=value, label=labeler(value), count=count)
        for value, count in sorted(
            counter.items(), key=lambda item: (-item[1], labeler(item[0]).lower())
        )
    ]


def _build_facets(
    memories: list[MemoryRecordResult],
    selected_project_id: str | None,
    selected_project_namespace: str | None,
) -> MemoryGraphFacets:
    project_counts = Counter(
        (*_project_identity(memory), _project_separator(memory)) for memory in memories
    )

    selected_memories = memories
    if selected_project_id:
        selected_memories = [
            memory
            for memory in memories
            if _project_identity(memory)[:2] == ("project_id", selected_project_id)
        ]
    elif selected_project_namespace:
        selected_memories = [
            memory
            for memory in memories
            if _project_identity(memory)[:2]
            == ("namespace", selected_project_namespace)
        ]

    namespace_counts = Counter(
        path
        for memory in selected_memories
        for path, _label in _namespace_paths(memory)
    )
    memory_type_counts = Counter(
        memory.memory_type.value for memory in selected_memories
    )
    agent_counts = Counter(
        _scope_value(memory.agent_id) for memory in selected_memories
    )

    return MemoryGraphFacets(
        projects=[
            MemoryGraphFacet(
                field=field,
                value=value,
                label=label,
                count=count,
                separator=separator if field == "namespace" else None,
            )
            for (field, value, label, separator), count in sorted(
                project_counts.items(),
                key=lambda item: (-item[1], item[0][2].lower()),
            )
        ],
        namespaces=_facet_list(namespace_counts),
        memory_types=_facet_list(memory_type_counts),
        agents=_facet_list(agent_counts, _scope_label),
    )


def build_memory_graph(
    memories: list[MemoryRecordResult],
    facet_memories: list[MemoryRecordResult],
    *,
    selected_project_id: str | None,
    selected_project_namespace: str | None,
    result_limit: int,
    truncated: bool,
    facets_truncated: bool,
) -> MemoryGraphResponse:
    """Turn checked memory fields into a compact graph for the browser."""

    nodes: dict[str, MemoryGraphNode] = {}
    edges: dict[tuple[str, str, str], MemoryGraphEdge] = {}

    namespace_counts: Counter[str] = Counter()
    topic_counts: Counter[str] = Counter()
    entity_counts: Counter[str] = Counter()

    for memory in memories:
        project_field, project_scope, _project_label = _project_identity(memory)
        namespace_counts.update(
            f"{project_field}:{project_scope}:{path}"
            for path, _label in _namespace_paths(memory)
        )
        topic_counts.update(_unique_values(memory.topics))
        entity_counts.update(_unique_values(memory.entities))

    visible_namespaces = _top_values(namespace_counts, _MAX_NAMESPACE_NODES)
    visible_topics = _top_values(topic_counts, _MAX_TOPIC_NODES)
    visible_entities = _top_values(entity_counts, _MAX_ENTITY_NODES)

    def add_edge(source: str, target: str, kind: str) -> None:
        key = (source, target, kind)
        if key in edges:
            return
        edges[key] = MemoryGraphEdge(
            id=_stable_id("edge", "|".join(key)),
            source=source,
            target=target,
            kind=kind,
        )

    memory_node_ids = {memory.id: f"memory:{memory.id}" for memory in memories}

    for memory in memories:
        memory_node_id = memory_node_ids[memory.id]
        project_field, project_scope, project_label = _project_identity(memory)
        project_node_id = _stable_id("project", f"{project_field}:{project_scope}")
        nodes[memory_node_id] = MemoryGraphNode(
            id=memory_node_id,
            kind="memory",
            label=_short_label(memory.text),
            value=memory.id,
            project_id=memory.project_id,
            project_label=project_label,
            memory=MemoryRecord.model_validate(memory.model_dump()),
        )
        nodes.setdefault(
            project_node_id,
            MemoryGraphNode(
                id=project_node_id,
                kind="project",
                label=project_label,
                value=project_scope,
                count=sum(
                    _project_identity(item)[:2] == (project_field, project_scope)
                    for item in memories
                ),
                project_id=memory.project_id,
                project_label=project_label,
            ),
        )
        add_edge(memory_node_id, project_node_id, "belongs_to")

        namespace_paths = _namespace_paths(memory)
        if namespace_paths:
            parent_node_id: str | None = None
            deepest_node_id: str | None = None
            for path, label in namespace_paths:
                scoped_path = f"{project_field}:{project_scope}:{path}"
                if scoped_path not in visible_namespaces:
                    continue
                namespace_node_id = _stable_id("namespace", scoped_path)
                nodes.setdefault(
                    namespace_node_id,
                    MemoryGraphNode(
                        id=namespace_node_id,
                        kind="namespace",
                        label=label,
                        value=path,
                        count=namespace_counts[scoped_path],
                        project_id=memory.project_id,
                        project_label=project_label,
                    ),
                )
                if parent_node_id:
                    add_edge(namespace_node_id, parent_node_id, "inside")
                else:
                    add_edge(namespace_node_id, project_node_id, "inside")
                parent_node_id = namespace_node_id
                deepest_node_id = namespace_node_id
            if deepest_node_id:
                add_edge(memory_node_id, deepest_node_id, "inside")

        for topic in _unique_values(memory.topics):
            if topic not in visible_topics:
                continue
            topic_node_id = _stable_id("topic", topic)
            nodes.setdefault(
                topic_node_id,
                MemoryGraphNode(
                    id=topic_node_id,
                    kind="topic",
                    label=topic,
                    value=topic,
                    count=topic_counts[topic],
                ),
            )
            add_edge(memory_node_id, topic_node_id, "tagged")

        for entity in _unique_values(memory.entities):
            if entity not in visible_entities:
                continue
            entity_node_id = _stable_id("entity", entity)
            nodes.setdefault(
                entity_node_id,
                MemoryGraphNode(
                    id=entity_node_id,
                    kind="entity",
                    label=entity,
                    value=entity,
                    count=entity_counts[entity],
                ),
            )
            add_edge(memory_node_id, entity_node_id, "mentions")

        for source_memory_id in memory.extracted_from or []:
            source_node_id = memory_node_ids.get(source_memory_id)
            if source_node_id:
                add_edge(memory_node_id, source_node_id, "derived_from")

    return MemoryGraphResponse(
        nodes=list(nodes.values()),
        edges=list(edges.values()),
        facets=_build_facets(
            facet_memories,
            selected_project_id,
            selected_project_namespace,
        ),
        memory_count=len(memories),
        result_limit=result_limit,
        truncated=truncated,
        facets_truncated=facets_truncated,
    )


async def load_memory_graph(
    *,
    project_id: str | None,
    project_namespace: str | None,
    project_separator: Literal["/", "."],
    namespace: str | None,
    search: str,
    memory_type: MemoryTypeEnum | None,
    agent_id: str | None,
    limit: int,
) -> MemoryGraphResponse:
    """Load graph memories with RedisVL-backed list or keyword search."""

    if project_id and project_namespace:
        raise HTTPException(
            status_code=400,
            detail="Choose either project_id or project_namespace, not both",
        )

    normalized_project_namespace = None
    normalized_namespace = None
    try:
        if project_namespace:
            normalized_project_namespace = normalize_namespace(project_namespace)
        if namespace:
            normalized_namespace = normalize_namespace(namespace)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if normalized_project_namespace and normalized_namespace:
        is_inside_project = normalized_namespace == normalized_project_namespace or (
            normalized_namespace.startswith(
                f"{normalized_project_namespace}{project_separator}"
            )
        )
        if not is_inside_project:
            raise HTTPException(
                status_code=400,
                detail="namespace must be inside the selected project namespace",
            )

    effective_namespace = normalized_namespace or normalized_project_namespace

    facet_results = await long_term_memory.search_long_term_memories(
        text="",
        search_mode=SearchModeEnum.KEYWORD,
        limit=_FACET_SCAN_LIMIT,
        offset=0,
    )

    async def search_graph_memories(namespace_filter: Namespace | None):
        return await long_term_memory.search_long_term_memories(
            text=search.strip(),
            search_mode=SearchModeEnum.KEYWORD,
            project_id=(
                ProjectId(eq=project_id)
                if project_id and project_id != SHARED_SCOPE
                else None
            ),
            namespace=namespace_filter,
            memory_type=(
                MemoryType(eq=memory_type.value) if memory_type is not None else None
            ),
            agent_id=AgentId(eq=agent_id) if agent_id else None,
            limit=limit,
            offset=0,
        )

    query_batches = []
    if effective_namespace:
        query_batches.append(
            await search_graph_memories(Namespace(eq=effective_namespace))
        )
        query_batches.append(
            await search_graph_memories(
                Namespace(startswith=f"{effective_namespace}{project_separator}")
            )
        )
    else:
        query_batches.append(await search_graph_memories(None))

    memories_by_id = {
        memory.id: memory for batch in query_batches for memory in batch.memories
    }
    graph_memories = list(memories_by_id.values())[:limit]
    if normalized_project_namespace:
        graph_memories = [
            memory
            for memory in graph_memories
            if _project_identity(memory)[:2]
            == ("namespace", normalized_project_namespace)
        ]
    elif project_id == SHARED_SCOPE:
        graph_memories = [
            memory
            for memory in graph_memories
            if _project_identity(memory)[:2] == ("project_id", SHARED_SCOPE)
        ]

    return build_memory_graph(
        graph_memories,
        facet_results.memories,
        selected_project_id=project_id,
        selected_project_namespace=normalized_project_namespace,
        result_limit=limit,
        truncated=(
            len(memories_by_id) > limit
            or any(len(batch.memories) >= limit for batch in query_batches)
        ),
        facets_truncated=len(facet_results.memories) >= _FACET_SCAN_LIMIT,
    )


@router.get(
    "/v1/admin/memories/graph",
    response_model=MemoryGraphResponse,
    response_model_exclude_none=True,
)
async def get_memory_graph(
    project_id: str | None = None,
    project_namespace: str | None = None,
    project_separator: Literal["/", "."] = "/",
    namespace: str | None = None,
    search: str = Query(default="", max_length=200),
    memory_type: MemoryTypeEnum | None = None,
    agent_id: str | None = None,
    limit: int = Query(default=250, ge=25, le=500),
    _current_user: UserInfo = Depends(get_current_user),
):
    """Return read-only memory graph data without creating embeddings."""

    return await load_memory_graph(
        project_id=project_id,
        project_namespace=project_namespace,
        project_separator=project_separator,
        namespace=namespace,
        search=search,
        memory_type=memory_type,
        agent_id=agent_id,
        limit=limit,
    )


@router.get("/admin/memories/graph", include_in_schema=False)
async def memory_graph_page(
    _current_user: UserInfo = Depends(get_current_user),
):
    """Serve the packaged human memory graph page."""

    return FileResponse(
        _UI_DIRECTORY / "graph.html",
        media_type="text/html",
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/admin/memories/graph/graph.css", include_in_schema=False)
async def memory_graph_styles(
    _current_user: UserInfo = Depends(get_current_user),
):
    """Serve the packaged graph styles."""

    return FileResponse(
        _UI_DIRECTORY / "graph.css",
        media_type="text/css",
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/admin/memories/graph/graph.js", include_in_schema=False)
async def memory_graph_script(
    _current_user: UserInfo = Depends(get_current_user),
):
    """Serve the packaged graph browser code."""

    return FileResponse(
        _UI_DIRECTORY / "graph.js",
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache"},
    )
