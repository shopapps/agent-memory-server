from unittest.mock import AsyncMock, patch

import pytest

from agent_memory_server.admin_graph import build_memory_graph
from agent_memory_server.config import settings
from agent_memory_server.models import MemoryRecordResult, MemoryRecordResults


def memory(memory_id: str, text: str, **values) -> MemoryRecordResult:
    return MemoryRecordResult(id=memory_id, text=text, dist=0.0, **values)


def test_build_memory_graph_uses_checked_memory_fields():
    memories = [
        memory(
            "one",
            "Archive login uses shared sessions",
            project_id="shopapps/prov-portal",
            namespace="code/auth",
            agent_id="codex",
            memory_type="semantic",
            topics=["authentication"],
            entities=["Redis"],
        ),
        memory(
            "two",
            "The session cookie is shared",
            project_id="shopapps/prov-portal",
            namespace="code/auth",
            agent_id="codex",
            memory_type="semantic",
            topics=["authentication"],
            entities=["Redis"],
            extracted_from=["one"],
        ),
    ]

    graph = build_memory_graph(
        memories,
        memories,
        selected_project_id="shopapps/prov-portal",
        selected_project_namespace=None,
        result_limit=250,
        truncated=False,
        facets_truncated=False,
    )

    assert graph.memory_count == 2
    assert {node.kind for node in graph.nodes} == {
        "memory",
        "project",
        "namespace",
        "topic",
        "entity",
    }
    assert {edge.kind for edge in graph.edges} == {
        "belongs_to",
        "inside",
        "tagged",
        "mentions",
        "derived_from",
    }
    selected = next(node for node in graph.nodes if node.id == "memory:one")
    assert selected.memory is not None
    assert selected.memory.text == "Archive login uses shared sessions"
    topic = next(
        node
        for node in graph.nodes
        if node.kind == "topic" and node.value == "authentication"
    )
    assert {
        edge.source
        for edge in graph.edges
        if edge.target == topic.id and edge.kind == "tagged"
    } == {"memory:one", "memory:two"}
    assert graph.facets.projects[0].label == "prov-portal"
    assert {facet.value for facet in graph.facets.namespaces} == {
        "code",
        "code/auth",
    }


def test_graph_uses_namespace_when_old_memories_have_no_project_id():
    memories = [
        memory(
            "one",
            "Portal login uses shared sessions",
            namespace="shopapps/prov-portal/code/auth",
            memory_type="semantic",
        ),
        memory(
            "two",
            "Roll20 attacks include a target",
            namespace="roll20-plugin",
            memory_type="semantic",
        ),
    ]

    graph = build_memory_graph(
        memories[:1],
        memories,
        selected_project_id=None,
        selected_project_namespace="shopapps/prov-portal",
        result_limit=250,
        truncated=False,
        facets_truncated=False,
    )

    projects = {
        (facet.field, facet.value, facet.label) for facet in graph.facets.projects
    }
    assert projects == {
        ("namespace", "shopapps/prov-portal", "prov-portal"),
        ("namespace", "roll20-plugin", "roll20-plugin"),
    }
    assert [facet.value for facet in graph.facets.namespaces] == [
        "shopapps/prov-portal/code",
        "shopapps/prov-portal/code/auth",
    ]
    assert next(node for node in graph.nodes if node.kind == "project").value == (
        "shopapps/prov-portal"
    )
    assert next(
        node for node in graph.nodes if node.kind == "memory"
    ).project_label == ("prov-portal")


def test_graph_supports_legacy_dot_separated_namespace_keys():
    memories = [
        memory(
            "one",
            "Portal auth fact",
            namespace="prov-portal.code.auth",
            memory_type="semantic",
        )
    ]

    graph = build_memory_graph(
        memories,
        memories,
        selected_project_id=None,
        selected_project_namespace="prov-portal",
        result_limit=250,
        truncated=False,
        facets_truncated=False,
    )

    assert graph.facets.projects[0].separator == "."
    assert {facet.value for facet in graph.facets.namespaces} == {
        "prov-portal.code",
        "prov-portal.code.auth",
    }


@pytest.mark.asyncio
async def test_graph_data_uses_filter_and_keyword_search_without_embeddings(client):
    facet_memories = [
        memory(
            "facet",
            "Facet memory",
            project_id="shopapps/prov-portal",
            namespace="code/auth",
            agent_id="codex",
            memory_type="semantic",
        )
    ]
    graph_memories = [
        memory(
            "result",
            "Archive login uses shared sessions",
            project_id="shopapps/prov-portal",
            namespace="code/auth",
            agent_id="codex",
            memory_type="semantic",
        )
    ]
    search = AsyncMock(
        side_effect=[
            MemoryRecordResults(memories=facet_memories, total=1),
            MemoryRecordResults(memories=graph_memories, total=1),
            MemoryRecordResults(memories=[], total=0),
        ]
    )

    with patch(
        "agent_memory_server.admin_graph.long_term_memory.search_long_term_memories",
        search,
    ):
        response = await client.get(
            "/v1/admin/memories/graph",
            params={
                "project_id": "shopapps/prov-portal",
                "namespace": "code",
                "search": "login",
                "memory_type": "semantic",
                "agent_id": "codex",
                "limit": 25,
            },
        )

    assert response.status_code == 200
    assert response.json()["memory_count"] == 1
    assert search.await_count == 3
    facet_call, exact_call, child_call = search.await_args_list
    assert facet_call.kwargs["text"] == ""
    assert exact_call.kwargs["text"] == "login"
    assert exact_call.kwargs["search_mode"].value == "keyword"
    assert exact_call.kwargs["project_id"].eq == "shopapps/prov-portal"
    assert exact_call.kwargs["namespace"].eq == "code"
    assert exact_call.kwargs["agent_id"].eq == "codex"
    assert child_call.kwargs["namespace"].startswith == "code/"


@pytest.mark.asyncio
async def test_graph_data_filters_an_inferred_namespace_project(client):
    project_memory = memory(
        "result",
        "Portal login uses shared sessions",
        namespace="shopapps/prov-portal/code/auth",
        memory_type="semantic",
    )
    search = AsyncMock(
        side_effect=[
            MemoryRecordResults(memories=[project_memory], total=1),
            MemoryRecordResults(memories=[project_memory], total=1),
            MemoryRecordResults(memories=[], total=0),
        ]
    )

    with patch(
        "agent_memory_server.admin_graph.long_term_memory.search_long_term_memories",
        search,
    ):
        response = await client.get(
            "/v1/admin/memories/graph",
            params={"project_namespace": "shopapps/prov-portal", "limit": 25},
        )

    assert response.status_code == 200
    assert response.json()["memory_count"] == 1
    exact_call, child_call = search.await_args_list[1:]
    assert exact_call.kwargs["project_id"] is None
    assert exact_call.kwargs["namespace"].eq == "shopapps/prov-portal"
    assert child_call.kwargs["namespace"].startswith == "shopapps/prov-portal/"


@pytest.mark.asyncio
async def test_graph_page_and_assets_are_packaged(client):
    page = await client.get("/admin/memories/graph")
    styles = await client.get("/admin/memories/graph/graph.css")
    script = await client.get("/admin/memories/graph/graph.js")

    assert page.status_code == 200
    assert "Memory Graph" in page.text
    assert 'id="working-memory-link"' in page.text
    assert "graph.js?v=live-refresh" in page.text
    assert page.headers["cache-control"] == "no-cache"
    assert styles.status_code == 200
    assert styles.headers["cache-control"] == "no-cache"
    assert "--canvas" in styles.text
    assert script.status_code == 200
    assert script.headers["cache-control"] == "no-cache"
    assert "requestAnimationFrame" in script.text
    assert 'url.searchParams.set("user_id", workingMemoryUserId)' in script.text
    assert 'initialParameters.get("memory_id")' in script.text
    assert "loadGraph(initialMemoryId)" in script.text
    assert "payload.expected_version = memory.updated_at" in script.text
    assert "History and undo" in script.text
    assert "expected_version: history.current_version" in script.text
    assert 'projectValue: initialParameters.get("project_id") || ""' in script.text
    assert 'id="edit-memory"' in page.text
    assert 'id="delete-memory"' in page.text
    assert ".edit-button[hidden]" in styles.text
    assert 'method: "PATCH"' in script.text
    assert "/v1/long-term-memory/" in script.text
    assert "connectedMemoryNodes" in script.text
    assert 'tagBlock("Topics", memory.topics, "topic")' in script.text
    assert 'tagBlock("Entities", memory.entities, "entity")' in script.text
    assert "focusGraphNode" in script.text
    assert ".tag-link" in styles.text
    assert "connectionCount" in script.text
    assert "createRadialGradient" in script.text
    assert 'method: "DELETE"' in script.text
    assert 'parameters.append("memory_ids", memory.id)' in script.text
    assert "const GRAPH_POLL_INTERVAL_MS = 10_000;" in script.text
    assert "function mergeGraph(data)" in script.text
    assert "Object.assign(existingNode, node" in script.text
    assert "state.newMemoryRipples.set(node.id" in script.text
    assert "delete stableMemory.last_accessed" in script.text
    assert script.text.count("state.deletingNodeId ||\n      searchTimer") == 1
    assert script.text.count("state.deletingNodeId ||\n        searchTimer") == 1
    assert "loadGraph(null, { merge: true, silent: true })" in script.text
    assert "window.setTimeout(pollGraph, GRAPH_POLL_INTERVAL_MS)" in script.text
    assert "setInterval(" not in script.text


@pytest.mark.asyncio
async def test_graph_page_and_assets_require_authentication(client, monkeypatch):
    monkeypatch.setattr(settings, "disable_auth", False)
    monkeypatch.setattr(settings, "auth_mode", "oauth2")

    for path in (
        "/admin/memories/graph",
        "/admin/memories/graph/graph.css",
        "/admin/memories/graph/graph.js",
    ):
        response = await client.get(path)
        assert response.status_code == 401
