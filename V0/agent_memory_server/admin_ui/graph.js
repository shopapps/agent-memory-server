const canvas = document.querySelector("#memory-graph");
const context = canvas.getContext("2d");
const stage = document.querySelector("#graph-stage");
const projectTabs = document.querySelector("#project-tabs");
const searchInput = document.querySelector("#search-input");
const namespaceFilter = document.querySelector("#namespace-filter");
const typeFilter = document.querySelector("#type-filter");
const agentFilter = document.querySelector("#agent-filter");
const resetViewButton = document.querySelector("#reset-view");
const inspector = document.querySelector("#inspector");
const inspectorKind = document.querySelector("#inspector-kind");
const inspectorTitle = document.querySelector("#inspector-title");
const inspectorBody = document.querySelector("#inspector-body");
const editMemoryButton = document.querySelector("#edit-memory");
const deleteMemoryButton = document.querySelector("#delete-memory");
const closeInspectorButton = document.querySelector("#close-inspector");
const emptyState = document.querySelector("#empty-state");
const loadStatus = document.querySelector("#load-status");
const pageNotice = document.querySelector("#page-notice");
const kindToggles = [...document.querySelectorAll(".kind-toggle")];

const NODE_COLORS = {
  memory: "#4d8fff",
  project: "#8b5cf6",
  namespace: "#22c7e6",
  topic: "#f4a620",
  entity: "#4bd879",
};

const NODE_RADII = {
  memory: 4,
  project: 11,
  namespace: 9,
  topic: 7,
  entity: 7,
};

const EDGE_LENGTHS = {
  belongs_to: 150,
  inside: 92,
  tagged: 118,
  mentions: 124,
  derived_from: 76,
};

const GRAPH_POLL_INTERVAL_MS = 10_000;
const NEW_MEMORY_RIPPLE_MS = 850;
const MAX_NEW_MEMORY_RIPPLES = 12;
const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
let reducedMotion = motionPreference.matches;
const state = {
  raw: null,
  graphSignature: "",
  nodes: [],
  edges: [],
  nodeById: new Map(),
  newMemoryRipples: new Map(),
  selectedNodeId: null,
  editingNodeId: null,
  deletingNodeId: null,
  hoveredNodeId: null,
  visibleKinds: new Set(["memory", "project", "namespace", "topic", "entity"]),
  projectField: "",
  projectValue: "",
  projectSeparator: "/",
  camera: { x: 0, y: 0, scale: 1 },
  autoFit: true,
  fitTick: 0,
  pointer: null,
  temperature: reducedMotion ? 0 : 1,
  animationFrame: null,
  loadNumber: 0,
  loadInFlight: false,
};

motionPreference.addEventListener?.("change", (event) => {
  reducedMotion = event.matches;
  if (reducedMotion) {
    state.newMemoryRipples.clear();
    state.temperature = 0;
  }
});

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let value = seed || 1;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function nodeRadius(node) {
  const base = NODE_RADII[node.kind] || 5;
  const connectionCount = Math.max(1, node.connectionCount || node.count || 1);
  const connectionBoost = Math.min(
    node.kind === "memory" ? 4.5 : 7,
    Math.log2(connectionCount + 1) * 1.35,
  );
  const textLength = node.memory?.text?.length || 0;
  const memorySizeBoost = node.kind === "memory" ? Math.min(4, Math.sqrt(textLength) / 6) : 0;
  const pinBoost = node.memory?.pinned ? 2 : 0;
  return base + connectionBoost + memorySizeBoost + pinBoost;
}

function resizeCanvas() {
  const bounds = stage.getBoundingClientRect();
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(bounds.width * pixelRatio));
  canvas.height = Math.max(1, Math.round(bounds.height * pixelRatio));
  canvas.style.width = `${bounds.width}px`;
  canvas.style.height = `${bounds.height}px`;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
}

function screenToWorld(screenX, screenY) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: (screenX - bounds.left - bounds.width / 2 - state.camera.x) / state.camera.scale,
    y: (screenY - bounds.top - bounds.height / 2 - state.camera.y) / state.camera.scale,
  };
}

function worldToScreen(node) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: bounds.width / 2 + state.camera.x + node.x * state.camera.scale,
    y: bounds.height / 2 + state.camera.y + node.y * state.camera.scale,
  };
}

function visibleNodes() {
  return state.nodes.filter((node) => state.visibleKinds.has(node.kind));
}

function visibleEdges(visibleIds) {
  return state.edges.filter(
    (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
  );
}

function graphSignature(data) {
  return JSON.stringify({
    nodes: data.nodes.map((node) => {
      if (!node.memory) return node;
      const stableMemory = { ...node.memory };
      delete stableMemory.access_count;
      delete stableMemory.last_accessed;
      return { ...node, memory: stableMemory };
    }),
    edges: data.edges,
    facets: data.facets,
    memory_count: data.memory_count,
    truncated: data.truncated,
    facets_truncated: data.facets_truncated,
  });
}

function connectionCounts(edges) {
  const counts = new Map();
  for (const edge of edges) {
    counts.set(edge.source, (counts.get(edge.source) || 0) + 1);
    counts.set(edge.target, (counts.get(edge.target) || 0) + 1);
  }
  return counts;
}

function initialiseGraph(data) {
  state.raw = data;
  state.graphSignature = graphSignature(data);
  state.nodeById = new Map();
  state.newMemoryRipples.clear();
  const counts = connectionCounts(data.edges);
  const random = seededRandom(hashString(JSON.stringify(data.nodes.map((node) => node.id))));
  const projectNodes = data.nodes.filter((node) => node.kind === "project");
  const projectPositions = new Map();

  projectNodes.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, projectNodes.length) - Math.PI / 2;
    const radius = projectNodes.length === 1 ? 0 : 230;
    projectPositions.set(node.id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  });

  const projectForMemory = new Map(
    data.edges
      .filter((edge) => edge.kind === "belongs_to")
      .map((edge) => [edge.source, edge.target]),
  );

  state.nodes = data.nodes.map((node) => {
    const projectNodeId =
      node.kind === "project" ? node.id : projectForMemory.get(node.id);
    const projectPosition = projectPositions.get(projectNodeId) || { x: 0, y: 0 };
    const angle = random() * Math.PI * 2;
    const radius = node.kind === "project" ? 0 : 54 + random() * 180;
    const position = projectPositions.get(node.id) || {
      x: projectPosition.x + Math.cos(angle) * radius,
      y: projectPosition.y + Math.sin(angle) * radius,
    };
    const graphNode = {
      ...node,
      connectionCount: counts.get(node.id) || 0,
      x: position.x,
      y: position.y,
      vx: 0,
      vy: 0,
      fixed: false,
      phase: random() * Math.PI * 2,
    };
    state.nodeById.set(graphNode.id, graphNode);
    return graphNode;
  });

  state.edges = data.edges;
  state.temperature = reducedMotion ? 0 : 0.42;
  state.autoFit = true;
  state.fitTick = 0;
  state.selectedNodeId = null;
  state.hoveredNodeId = null;
  closeInspector();
  emptyState.hidden = data.memory_count > 0;
  resetCamera(false);
  state.autoFit = true;
}

function positionForNewNode(node, data, positionedNodes, random) {
  const anchors = [];
  for (const edge of data.edges) {
    let connectedId = null;
    if (edge.source === node.id) connectedId = edge.target;
    if (edge.target === node.id) connectedId = edge.source;
    const connectedNode = connectedId ? positionedNodes.get(connectedId) : null;
    if (connectedNode) anchors.push(connectedNode);
  }

  const centre = anchors.length
    ? {
        x: anchors.reduce((sum, anchor) => sum + anchor.x, 0) / anchors.length,
        y: anchors.reduce((sum, anchor) => sum + anchor.y, 0) / anchors.length,
      }
    : {
        x: -state.camera.x / state.camera.scale,
        y: -state.camera.y / state.camera.scale,
      };
  const angle = random() * Math.PI * 2;
  const distance = node.kind === "project" ? 72 : 28 + random() * 34;
  return {
    x: centre.x + Math.cos(angle) * distance,
    y: centre.y + Math.sin(angle) * distance,
  };
}

function mergeGraph(data) {
  const signature = graphSignature(data);
  if (signature === state.graphSignature) return 0;

  const existingNodes = state.nodeById;
  const positionedNodes = new Map(existingNodes);
  const nextNodeById = new Map();
  const nextNodes = [];
  const counts = connectionCounts(data.edges);
  const random = seededRandom(hashString(JSON.stringify(data.nodes.map((node) => node.id))));
  const newMemoryNodes = [];

  for (const node of data.nodes) {
    const existingNode = existingNodes.get(node.id);
    if (existingNode) {
      Object.assign(existingNode, node, {
        connectionCount: counts.get(node.id) || 0,
      });
      nextNodes.push(existingNode);
      nextNodeById.set(existingNode.id, existingNode);
      continue;
    }

    const position = positionForNewNode(node, data, positionedNodes, random);
    const graphNode = {
      ...node,
      connectionCount: counts.get(node.id) || 0,
      x: position.x,
      y: position.y,
      vx: 0,
      vy: 0,
      fixed: false,
      phase: random() * Math.PI * 2,
    };
    nextNodes.push(graphNode);
    nextNodeById.set(graphNode.id, graphNode);
    positionedNodes.set(graphNode.id, graphNode);
    if (graphNode.kind === "memory") newMemoryNodes.push(graphNode);
  }

  state.raw = data;
  state.graphSignature = signature;
  state.nodes = nextNodes;
  state.nodeById = nextNodeById;
  state.edges = data.edges;
  emptyState.hidden = data.memory_count > 0;

  if (!reducedMotion) {
    const startedAt = performance.now();
    for (const node of newMemoryNodes.slice(-MAX_NEW_MEMORY_RIPPLES)) {
      state.newMemoryRipples.set(node.id, startedAt);
    }
    while (state.newMemoryRipples.size > MAX_NEW_MEMORY_RIPPLES) {
      state.newMemoryRipples.delete(state.newMemoryRipples.keys().next().value);
    }
  }

  if (state.selectedNodeId) {
    const selectedNode = state.nodeById.get(state.selectedNodeId);
    if (!selectedNode) {
      closeInspector();
    } else if (!state.editingNodeId && !state.deletingNodeId) {
      renderInspectorDetails(selectedNode);
    }
  }

  return newMemoryNodes.length;
}

function stepSimulation() {
  if (state.temperature < 0.008 || reducedMotion) {
    return;
  }

  const nodes = visibleNodes();
  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges = visibleEdges(visibleIds);
  const repulsion = nodes.length > 360 ? 260 : nodes.length > 120 ? 180 : 240;

  for (let left = 0; left < nodes.length; left += 1) {
    const first = nodes[left];
    for (let right = left + 1; right < nodes.length; right += 1) {
      if (nodes.length > 360 && (left + right) % 2 === 1) {
        continue;
      }
      const second = nodes[right];
      let dx = second.x - first.x;
      let dy = second.y - first.y;
      let distanceSquared = dx * dx + dy * dy;
      if (distanceSquared < 1) {
        dx = 0.5;
        dy = 0.5;
        distanceSquared = 0.5;
      }
      const force = (repulsion * state.temperature) / distanceSquared;
      first.vx -= dx * force;
      first.vy -= dy * force;
      second.vx += dx * force;
      second.vy += dy * force;
    }
  }

  for (const edge of edges) {
    const source = state.nodeById.get(edge.source);
    const target = state.nodeById.get(edge.target);
    if (!source || !target) continue;
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const ideal = EDGE_LENGTHS[edge.kind] || 110;
    const force = ((distance - ideal) / distance) * 0.008 * state.temperature;
    source.vx += dx * force;
    source.vy += dy * force;
    target.vx -= dx * force;
    target.vy -= dy * force;
  }

  for (const node of nodes) {
    if (node.fixed) continue;
    node.vx += -node.x * 0.0025 * state.temperature;
    node.vy += -node.y * 0.0025 * state.temperature;
    node.vx *= 0.84;
    node.vy *= 0.84;
    node.x += node.vx;
    node.y += node.vy;
  }

  state.temperature *= 0.985;
}

function fitCameraToNodes() {
  const nodes = visibleNodes();
  if (!nodes.length) return;
  const bounds = canvas.getBoundingClientRect();
  const padding = 72;
  const xValues = nodes.map((node) => node.x);
  const yValues = nodes.map((node) => node.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const graphWidth = Math.max(1, maxX - minX);
  const graphHeight = Math.max(1, maxY - minY);
  const scale = Math.min(
    1.15,
    Math.max(
      0.16,
      Math.min(
        Math.max(1, bounds.width - padding * 2) / graphWidth,
        Math.max(1, bounds.height - padding * 2) / graphHeight,
      ),
    ),
  );
  state.camera = {
    x: -((minX + maxX) / 2) * scale,
    y: -((minY + maxY) / 2) * scale,
    scale,
  };
}

function connectedNodeIds(nodeId) {
  const connected = new Set([nodeId]);
  for (const edge of state.edges) {
    if (edge.source === nodeId) connected.add(edge.target);
    if (edge.target === nodeId) connected.add(edge.source);
  }
  return connected;
}

function drawGraph(timestamp = 0) {
  stepSimulation();
  state.fitTick += 1;
  if (state.autoFit && (state.fitTick % 6 === 0 || state.temperature < 0.02)) {
    fitCameraToNodes();
    if (state.temperature < 0.02) state.autoFit = false;
  }

  const bounds = canvas.getBoundingClientRect();
  context.clearRect(0, 0, bounds.width, bounds.height);

  const nodes = visibleNodes();
  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges = visibleEdges(visibleIds);
  const highlighted = state.selectedNodeId
    ? connectedNodeIds(state.selectedNodeId)
    : new Set();

  context.save();
  context.lineCap = "round";
  for (const edge of edges) {
    const source = state.nodeById.get(edge.source);
    const target = state.nodeById.get(edge.target);
    if (!source || !target) continue;
    const sourcePoint = worldToScreen(source);
    const targetPoint = worldToScreen(target);
    const selectedEdge =
      state.selectedNodeId &&
      (edge.source === state.selectedNodeId || edge.target === state.selectedNodeId);
    context.beginPath();
    context.moveTo(sourcePoint.x, sourcePoint.y);
    context.lineTo(targetPoint.x, targetPoint.y);
    context.strokeStyle = selectedEdge ? "rgba(77, 143, 255, 0.82)" : "rgba(119, 139, 171, 0.25)";
    context.lineWidth = selectedEdge ? 1.4 : 0.75;
    context.stroke();
  }
  context.restore();

  for (const node of nodes) {
    const point = worldToScreen(node);
    const isSelected = node.id === state.selectedNodeId;
    const isHovered = node.id === state.hoveredNodeId;
    const isMuted = state.selectedNodeId && !highlighted.has(node.id);
    const twinkle = reducedMotion ? 1 : 0.9 + Math.sin(timestamp / 900 + node.phase) * 0.1;
    const radius = nodeRadius(node) * state.camera.scale * twinkle;
    const color = NODE_COLORS[node.kind];

    context.save();
    const rippleStartedAt = state.newMemoryRipples.get(node.id);
    if (rippleStartedAt !== undefined) {
      const rippleProgress = Math.max(
        0,
        Math.min(1, (timestamp - rippleStartedAt) / NEW_MEMORY_RIPPLE_MS),
      );
      if (rippleProgress >= 1 || reducedMotion) {
        state.newMemoryRipples.delete(node.id);
      } else {
        const easedProgress = 1 - (1 - rippleProgress) ** 3;
        context.globalAlpha = (1 - rippleProgress) * 0.8;
        context.strokeStyle = color;
        context.lineWidth = Math.max(1, 2 * state.camera.scale);
        context.beginPath();
        context.arc(
          point.x,
          point.y,
          Math.max(9, radius + 7 + easedProgress * 24),
          0,
          Math.PI * 2,
        );
        context.stroke();
      }
    }

    const haloRadius = Math.max(
      13,
      radius * (isSelected ? 3.8 : isHovered ? 3.3 : 2.75),
    );
    const halo = context.createRadialGradient(
      point.x,
      point.y,
      Math.max(1, radius * 0.35),
      point.x,
      point.y,
      haloRadius,
    );
    halo.addColorStop(0, `${color}8c`);
    halo.addColorStop(0.38, `${color}40`);
    halo.addColorStop(1, `${color}00`);
    context.globalAlpha = isMuted ? 0.12 : isSelected ? 0.9 : 0.64;
    context.fillStyle = halo;
    context.beginPath();
    context.arc(point.x, point.y, haloRadius, 0, Math.PI * 2);
    context.fill();

    context.globalAlpha = isMuted ? 0.26 : 1;
    context.shadowColor = color;
    context.shadowBlur = (isSelected ? 22 : isHovered ? 15 : 9) * state.camera.scale;
    context.fillStyle = color;
    context.beginPath();
    context.arc(point.x, point.y, Math.max(2.8, radius), 0, Math.PI * 2);
    context.fill();

    if (isSelected) {
      context.shadowBlur = 0;
      context.strokeStyle = "rgba(219, 235, 255, 0.95)";
      context.lineWidth = 2;
      context.beginPath();
      context.arc(point.x, point.y, Math.max(8, radius + 7), 0, Math.PI * 2);
      context.stroke();
    }

    const showLabel =
      isSelected ||
      isHovered ||
      node.kind === "project" ||
      (node.kind !== "memory" && node.count > 1 && state.camera.scale > 0.52);
    if (showLabel) {
      context.shadowBlur = 0;
      context.globalAlpha = isMuted ? 0.34 : 0.94;
      context.fillStyle = "#eef4ff";
      context.font = `${isSelected ? 600 : 500} ${isSelected ? 13 : 12}px Inter, ui-sans-serif, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "top";
      context.fillText(node.label, point.x, point.y + Math.max(9, radius + 7), 220);
    }
    context.restore();
  }

  state.animationFrame = requestAnimationFrame(drawGraph);
}

function findNodeAt(clientX, clientY) {
  const bounds = canvas.getBoundingClientRect();
  const x = clientX - bounds.left;
  const y = clientY - bounds.top;
  const nodes = visibleNodes();
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    const point = worldToScreen(node);
    const hitRadius = Math.max(10, nodeRadius(node) * state.camera.scale + 5);
    if (Math.hypot(point.x - x, point.y - y) <= hitRadius) {
      return node;
    }
  }
  return null;
}

function onPointerDown(event) {
  state.autoFit = false;
  canvas.setPointerCapture(event.pointerId);
  const node = findNodeAt(event.clientX, event.clientY);
  const world = screenToWorld(event.clientX, event.clientY);
  state.pointer = {
    id: event.pointerId,
    node,
    startX: event.clientX,
    startY: event.clientY,
    cameraX: state.camera.x,
    cameraY: state.camera.y,
    moved: false,
  };
  if (node) {
    node.fixed = true;
    node.x = world.x;
    node.y = world.y;
    selectNode(node);
  }
  canvas.classList.add("dragging");
}

function onPointerMove(event) {
  if (!state.pointer) {
    const hovered = findNodeAt(event.clientX, event.clientY);
    state.hoveredNodeId = hovered?.id || null;
    canvas.style.cursor = hovered ? "pointer" : "grab";
    return;
  }

  const dx = event.clientX - state.pointer.startX;
  const dy = event.clientY - state.pointer.startY;
  state.pointer.moved ||= Math.hypot(dx, dy) > 3;
  if (state.pointer.node) {
    const world = screenToWorld(event.clientX, event.clientY);
    state.pointer.node.x = world.x;
    state.pointer.node.y = world.y;
    state.pointer.node.vx = 0;
    state.pointer.node.vy = 0;
  } else {
    state.camera.x = state.pointer.cameraX + dx;
    state.camera.y = state.pointer.cameraY + dy;
  }
}

function onPointerUp(event) {
  if (!state.pointer || state.pointer.id !== event.pointerId) return;
  if (state.pointer.node) {
    state.pointer.node.fixed = false;
    state.temperature = Math.max(state.temperature, 0.18);
  } else if (!state.pointer.moved) {
    closeInspector();
  }
  state.pointer = null;
  canvas.classList.remove("dragging");
}

function onWheel(event) {
  event.preventDefault();
  state.autoFit = false;
  const bounds = canvas.getBoundingClientRect();
  const screenX = event.clientX - bounds.left;
  const screenY = event.clientY - bounds.top;
  const world = screenToWorld(event.clientX, event.clientY);
  const factor = Math.exp(-event.deltaY * 0.0012);
  const nextScale = Math.min(3.4, Math.max(0.28, state.camera.scale * factor));
  state.camera.scale = nextScale;
  state.camera.x = screenX - bounds.width / 2 - world.x * nextScale;
  state.camera.y = screenY - bounds.height / 2 - world.y * nextScale;
}

function resetCamera(reheat = true) {
  fitCameraToNodes();
  state.autoFit = reheat && !reducedMotion;
  state.fitTick = 0;
  if (reheat && !reducedMotion) state.temperature = 0.45;
}

function detailBlock(label, value, className = "") {
  if (value === null || value === undefined || value === "") return null;
  const block = document.createElement("section");
  block.className = "detail-block";
  const heading = document.createElement("span");
  heading.className = "detail-label";
  heading.textContent = label;
  const content = document.createElement("p");
  content.className = `detail-value ${className}`.trim();
  content.textContent = value;
  block.append(heading, content);
  return block;
}

function revealNodeKind(kind) {
  state.visibleKinds.add(kind);
  const toggle = kindToggles.find((item) => item.dataset.kind === kind);
  toggle?.setAttribute("aria-pressed", "true");
}

function focusGraphNode(node) {
  revealNodeKind(node.kind);
  selectNode(node);
  state.autoFit = false;

  const scale = Math.max(0.85, Math.min(1.35, state.camera.scale));
  const inspectorBounds = inspector.getBoundingClientRect();
  const inspectorIsBelow = window.matchMedia("(max-width: 760px)").matches;
  state.camera = {
    x: -node.x * scale,
    y: -node.y * scale - (inspectorIsBelow ? inspectorBounds.height / 2 : 0),
    scale,
  };
}

function tagBlock(label, values, nodeKind) {
  if (!values?.length) return null;
  const block = document.createElement("section");
  block.className = "detail-block";
  const heading = document.createElement("span");
  heading.className = "detail-label";
  heading.textContent = label;
  const tags = document.createElement("div");
  tags.className = "tag-list";
  for (const value of values) {
    const relatedNode = state.nodes.find(
      (node) => node.kind === nodeKind && node.value === value,
    );
    const tag = document.createElement(relatedNode ? "button" : "span");
    tag.className = "tag";
    tag.textContent = value;
    if (relatedNode) {
      tag.type = "button";
      tag.classList.add("tag-link", nodeKind);
      tag.setAttribute("aria-label", `Open ${nodeKind}: ${value}`);
      tag.addEventListener("click", () => focusGraphNode(relatedNode));
    }
    tags.append(tag);
  }
  block.append(heading, tags);
  return block;
}

function connectedMemoryNodes(node) {
  if (node.memory) return [];

  const memories = new Map();
  const visited = new Set([node.id]);
  const queue = [node.id];

  while (queue.length) {
    const currentNodeId = queue.shift();
    for (const edge of state.edges) {
      if (edge.target !== currentNodeId) continue;
      const sourceNode = state.nodeById.get(edge.source);
      if (!sourceNode || visited.has(sourceNode.id)) continue;
      visited.add(sourceNode.id);
      if (sourceNode.memory) {
        memories.set(sourceNode.id, sourceNode);
      } else if (sourceNode.kind === "namespace") {
        queue.push(sourceNode.id);
      }
    }
  }

  return [...memories.values()].sort((first, second) =>
    first.label.localeCompare(second.label),
  );
}

function connectedMemoriesBlock(node) {
  const memories = connectedMemoryNodes(node);
  const block = document.createElement("section");
  block.className = "detail-block";
  const heading = document.createElement("span");
  heading.className = "detail-label";
  heading.textContent = `Connected memories (${memories.length})`;
  block.append(heading);

  if (!memories.length) {
    const empty = document.createElement("p");
    empty.className = "detail-value";
    empty.textContent = "No connected memories are shown in this graph.";
    block.append(empty);
    return block;
  }

  const list = document.createElement("div");
  list.className = "connected-memory-list";
  for (const memoryNode of memories.slice(0, 60)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "connected-memory-link";
    button.setAttribute("aria-label", `Open memory: ${memoryNode.label}`);
    const title = document.createElement("strong");
    title.textContent = memoryNode.label;
    const scope = document.createElement("span");
    scope.textContent = [
      memoryNode.memory.memory_type,
      memoryNode.memory.namespace,
    ]
      .filter(Boolean)
      .join(" · ");
    button.append(title, scope);
    button.addEventListener("click", () => selectNode(memoryNode));
    list.append(button);
  }
  block.append(list);

  if (memories.length > 60) {
    const note = document.createElement("p");
    note.className = "connected-memory-note";
    note.textContent = `Showing the first 60 of ${memories.length} memories.`;
    block.append(note);
  }
  return block;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

let noticeTimer;
function showNotice(message, isError = false) {
  window.clearTimeout(noticeTimer);
  pageNotice.textContent = message;
  pageNotice.classList.toggle("error", isError);
  pageNotice.hidden = false;
  noticeTimer = window.setTimeout(() => {
    pageNotice.hidden = true;
  }, 3600);
}

function editField(labelText, control, helpText = "") {
  const label = document.createElement("label");
  label.className = "edit-field";
  const text = document.createElement("span");
  text.className = "edit-field-label";
  text.textContent = labelText;
  label.append(text, control);
  if (helpText) {
    const help = document.createElement("span");
    help.className = "edit-help";
    help.textContent = helpText;
    label.append(help);
  }
  return label;
}

function parseList(value) {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function listsMatch(first = [], second = []) {
  return (
    first.length === second.length && first.every((item, index) => item === second[index])
  );
}

function renderInspectorDetails(node) {
  state.editingNodeId = null;
  state.deletingNodeId = null;
  inspectorKind.textContent = node.kind;
  inspectorKind.style.color = NODE_COLORS[node.kind];
  inspectorTitle.textContent = node.label;
  editMemoryButton.hidden = !node.memory;
  deleteMemoryButton.hidden = !node.memory;
  inspectorBody.replaceChildren();
  inspectorBody.scrollTop = 0;

  if (node.memory) {
    const memory = node.memory;
    const blocks = [
      detailBlock("Memory", memory.text, "memory-copy"),
      detailBlock("Project", node.project_label || memory.project_id || "Shared"),
      detailBlock("Namespace", memory.namespace || "None"),
      detailBlock("Type", memory.memory_type),
      detailBlock("Pinned", memory.pinned ? "Yes" : "No"),
      detailBlock("Agent", memory.agent_id || "Shared"),
      detailBlock("User", memory.user_id || "Shared"),
      detailBlock("Session", memory.session_id || "Shared"),
      detailBlock("Created", formatDate(memory.created_at)),
      detailBlock("Updated", formatDate(memory.updated_at)),
      detailBlock("Last used", formatDate(memory.last_accessed)),
      tagBlock("Topics", memory.topics, "topic"),
      tagBlock("Entities", memory.entities, "entity"),
      detailBlock("Memory ID", memory.id),
    ].filter(Boolean);
    inspectorBody.append(...blocks);
  } else {
    const blocks = [
      detailBlock("Value", node.value),
      detailBlock("Connected nodes", String(node.connectionCount || node.count || 0)),
      detailBlock("Project", node.project_label || node.project_id || null),
      connectedMemoriesBlock(node),
    ].filter(Boolean);
    inspectorBody.append(...blocks);
  }
}

async function saveMemoryEdit(node, form, status, saveButton, cancelButton) {
  const memory = node.memory;
  if (!memory) return;

  const text = form.elements.text.value.trim();
  if (!text) {
    status.textContent = "Memory text cannot be empty.";
    status.classList.add("error");
    form.elements.text.focus();
    return;
  }

  const topics = parseList(form.elements.topics.value);
  const entities = parseList(form.elements.entities.value);
  const payload = {};
  if (text !== memory.text) payload.text = text;
  if (form.elements.memory_type.value !== memory.memory_type) {
    payload.memory_type = form.elements.memory_type.value;
  }
  if (!listsMatch(topics, memory.topics || [])) payload.topics = topics;
  if (!listsMatch(entities, memory.entities || [])) payload.entities = entities;
  if (form.elements.pinned.checked !== Boolean(memory.pinned)) {
    payload.pinned = form.elements.pinned.checked;
  }

  if (!Object.keys(payload).length) {
    renderInspectorDetails(node);
    showNotice("No changes to save.");
    return;
  }

  saveButton.disabled = true;
  cancelButton.disabled = true;
  saveButton.textContent = "Saving…";
  status.textContent = "Saving and rebuilding search data…";
  status.classList.remove("error");

  try {
    const response = await fetch(
      `/v1/long-term-memory/${encodeURIComponent(memory.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      let message = `The memory could not be saved (${response.status}).`;
      try {
        const body = await response.json();
        if (typeof body.detail === "string") message = body.detail;
        if (Array.isArray(body.detail)) {
          message = body.detail.map((item) => item.msg || String(item)).join(" ");
        }
      } catch {
        // Keep the clear status-based message when no JSON body is available.
      }
      throw new Error(message);
    }

    const updatedMemory = await response.json();
    await loadGraph(updatedMemory.id);
    showNotice("Memory saved.");
  } catch (error) {
    if (!form.isConnected) return;
    status.textContent =
      error instanceof Error ? error.message : "The memory could not be saved.";
    status.classList.add("error");
    saveButton.disabled = false;
    cancelButton.disabled = false;
    saveButton.textContent = "Save changes";
  }
}

function renderInspectorEditor(node) {
  const memory = node.memory;
  if (!memory) return;

  state.editingNodeId = node.id;
  state.deletingNodeId = null;
  inspectorKind.textContent = "Editing";
  inspectorKind.style.color = NODE_COLORS.memory;
  inspectorTitle.textContent = node.label;
  editMemoryButton.hidden = true;
  deleteMemoryButton.hidden = true;
  inspectorBody.replaceChildren();
  inspectorBody.scrollTop = 0;

  const form = document.createElement("form");
  form.className = "memory-edit-form";

  const text = document.createElement("textarea");
  text.name = "text";
  text.required = true;
  text.value = memory.text;

  const memoryType = document.createElement("select");
  memoryType.name = "memory_type";
  for (const value of ["semantic", "episodic", "message"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = value === memory.memory_type;
    memoryType.append(option);
  }

  const topics = document.createElement("textarea");
  topics.name = "topics";
  topics.value = (memory.topics || []).join("\n");

  const entities = document.createElement("textarea");
  entities.name = "entities";
  entities.value = (memory.entities || []).join("\n");

  const pinned = document.createElement("input");
  pinned.name = "pinned";
  pinned.type = "checkbox";
  pinned.checked = Boolean(memory.pinned);
  const pinLabel = document.createElement("label");
  pinLabel.className = "pin-control";
  const pinText = document.createElement("span");
  pinText.textContent = "Keep this memory pinned";
  pinLabel.append(pinned, pinText);

  const status = document.createElement("p");
  status.className = "edit-status";
  status.setAttribute("role", "status");
  status.textContent =
    "Saving rebuilds search data and may use credits from your embedding provider.";

  const actions = document.createElement("div");
  actions.className = "edit-form-actions";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "form-button";
  cancelButton.textContent = "Cancel";
  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  saveButton.className = "form-button primary";
  saveButton.textContent = "Save changes";
  actions.append(cancelButton, saveButton);

  form.append(
    editField("Memory", text),
    editField("Memory type", memoryType),
    editField("Topics", topics, "One topic per line."),
    editField("Entities", entities, "One entity per line."),
    pinLabel,
    status,
    actions,
  );
  inspectorBody.append(form);

  cancelButton.addEventListener("click", () => renderInspectorDetails(node));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveMemoryEdit(node, form, status, saveButton, cancelButton);
  });
  text.focus();
}

async function deleteSelectedMemory(node, status, confirmButton, cancelButton) {
  const memory = node.memory;
  if (!memory || confirmButton.disabled) return;

  confirmButton.disabled = true;
  cancelButton.disabled = true;
  confirmButton.textContent = "Deleting…";
  status.textContent = "Deleting this memory…";
  status.classList.remove("error");

  const parameters = new URLSearchParams();
  parameters.append("memory_ids", memory.id);

  try {
    const response = await fetch(`/v1/long-term-memory?${parameters}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      let message = `The memory could not be deleted (${response.status}).`;
      try {
        const body = await response.json();
        if (typeof body.detail === "string") message = body.detail;
      } catch {
        // Keep the clear status-based message when no JSON body is available.
      }
      throw new Error(message);
    }

    const body = await response.json();
    const deletedCount = Number(body.status?.match(/deleted (\d+) memories/)?.[1]);
    await loadGraph();
    showNotice(
      deletedCount === 0 ? "Memory was already missing." : "Memory deleted.",
    );
  } catch (error) {
    if (!status.isConnected) return;
    status.textContent =
      error instanceof Error ? error.message : "The memory could not be deleted.";
    status.classList.add("error");
    confirmButton.disabled = false;
    cancelButton.disabled = false;
    confirmButton.textContent = "Delete memory";
  }
}

function renderDeleteConfirmation(node) {
  const memory = node.memory;
  if (!memory) return;

  state.editingNodeId = null;
  state.deletingNodeId = node.id;
  inspectorKind.textContent = "Delete memory";
  inspectorKind.style.color = NODE_COLORS.memory;
  inspectorTitle.textContent = node.label;
  editMemoryButton.hidden = true;
  deleteMemoryButton.hidden = true;
  inspectorBody.replaceChildren();
  inspectorBody.scrollTop = 0;

  const confirmation = document.createElement("div");
  confirmation.className = "delete-confirmation";
  const warning = document.createElement("p");
  warning.className = "delete-warning";
  warning.textContent = "Delete this memory permanently?";
  const explanation = document.createElement("p");
  explanation.className = "delete-explanation";
  explanation.textContent = memory.pinned
    ? "This cannot be undone. This memory is pinned, but manual deletion will still remove it."
    : "This cannot be undone. Related memories will not be deleted.";
  const preview = document.createElement("p");
  preview.className = "delete-preview";
  preview.textContent = `${memory.text}\n\nID: ${memory.id}`;
  const status = document.createElement("p");
  status.className = "delete-status";
  status.setAttribute("role", "status");
  const actions = document.createElement("div");
  actions.className = "edit-form-actions";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "form-button";
  cancelButton.textContent = "Cancel";
  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "form-button danger";
  confirmButton.textContent = "Delete memory";
  actions.append(cancelButton, confirmButton);
  confirmation.append(warning, explanation, preview, status, actions);
  inspectorBody.append(confirmation);

  cancelButton.addEventListener("click", () => renderInspectorDetails(node));
  confirmButton.addEventListener("click", () =>
    deleteSelectedMemory(node, status, confirmButton, cancelButton),
  );
  cancelButton.focus({ preventScroll: true });
  inspectorBody.scrollTop = 0;
}

function selectNode(node) {
  state.selectedNodeId = node.id;
  renderInspectorDetails(node);

  inspector.classList.add("open");
  inspector.setAttribute("aria-hidden", "false");
}

function closeInspector() {
  state.selectedNodeId = null;
  state.editingNodeId = null;
  state.deletingNodeId = null;
  editMemoryButton.hidden = true;
  deleteMemoryButton.hidden = true;
  inspectorKind.textContent = "Memory";
  inspectorKind.style.color = NODE_COLORS.memory;
  inspectorTitle.textContent = "Select a memory";
  inspectorBody.replaceChildren();
  inspector.classList.remove("open");
  inspector.setAttribute("aria-hidden", "true");
}

function setSelectOptions(select, firstLabel, facets) {
  const currentValue = select.value;
  select.replaceChildren();
  const first = document.createElement("option");
  first.value = "";
  first.textContent = firstLabel;
  select.append(first);
  for (const facet of facets) {
    const option = document.createElement("option");
    option.value = facet.value;
    option.textContent = `${facet.label} (${facet.count})`;
    select.append(option);
  }
  if (
    currentValue &&
    ![...select.options].some((option) => option.value === currentValue)
  ) {
    const selected = document.createElement("option");
    selected.value = currentValue;
    selected.textContent = `${currentValue} (selected)`;
    select.append(selected);
  }
  select.value = currentValue;
}

function renderProjectTabs(facets) {
  const allCount = facets.reduce((sum, facet) => sum + facet.count, 0);
  const choices = [
    { field: "", value: "", label: "All", count: allCount, separator: "/" },
    ...facets,
  ];
  if (
    state.projectValue &&
    !facets.some(
      (facet) =>
        facet.field === state.projectField && facet.value === state.projectValue,
    )
  ) {
    choices.push({
      field: state.projectField,
      value: state.projectValue,
      label: state.projectValue.split(/[/.]/).at(-1),
      count: 0,
      separator: state.projectSeparator,
    });
  }
  projectTabs.replaceChildren();

  for (const choice of choices) {
    const isSelected =
      state.projectField === (choice.field || "") &&
      state.projectValue === choice.value;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project-tab";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(isSelected));
    const dot = document.createElement("span");
    dot.className = "tab-dot";
    const label = document.createElement("span");
    label.textContent = choice.label;
    const count = document.createElement("span");
    count.className = "tab-count";
    count.textContent = String(choice.count);
    button.append(dot, label, count);
    button.addEventListener("click", () => {
      if (isSelected) return;
      state.projectField = choice.field || "";
      state.projectValue = choice.value;
      state.projectSeparator = choice.separator || "/";
      namespaceFilter.value = "";
      loadGraph();
    });
    projectTabs.append(button);
  }
}

async function loadGraph(
  selectedMemoryId = null,
  { merge = false, silent = false } = {},
) {
  if (
    silent &&
    (state.loadInFlight ||
      document.hidden ||
      navigator.onLine === false ||
      state.pointer ||
      state.editingNodeId ||
      state.deletingNodeId ||
      searchTimer)
  ) {
    return;
  }

  const loadNumber = ++state.loadNumber;
  state.loadInFlight = true;
  if (!silent) {
    loadStatus.classList.remove("error");
    loadStatus.textContent = "Loading memories…";
  }

  const parameters = new URLSearchParams({ limit: "250" });
  if (state.projectField && state.projectValue) {
    const parameterName =
      state.projectField === "namespace" ? "project_namespace" : "project_id";
    parameters.set(parameterName, state.projectValue);
    if (state.projectField === "namespace") {
      parameters.set("project_separator", state.projectSeparator);
    }
  }
  if (namespaceFilter.value) parameters.set("namespace", namespaceFilter.value);
  if (typeFilter.value) parameters.set("memory_type", typeFilter.value);
  if (agentFilter.value) parameters.set("agent_id", agentFilter.value);
  if (searchInput.value.trim()) parameters.set("search", searchInput.value.trim());

  try {
    const response = await fetch(`/v1/admin/memories/graph?${parameters}`);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("Sign in is needed to load memory data.");
      }
      throw new Error(`The memory graph could not load (${response.status}).`);
    }
    const data = await response.json();
    if (loadNumber !== state.loadNumber) return;
    if (
      silent &&
      (document.hidden ||
        state.pointer ||
        state.editingNodeId ||
        state.deletingNodeId ||
        searchTimer)
    ) {
      return;
    }

    const previousFacets = JSON.stringify(state.raw?.facets || null);
    const nextFacets = JSON.stringify(data.facets);
    const graphChanged = state.graphSignature !== graphSignature(data);
    if (merge && state.raw) {
      mergeGraph(data);
    } else {
      initialiseGraph(data);
    }
    if (!merge || previousFacets !== nextFacets) {
      renderProjectTabs(data.facets.projects);
      setSelectOptions(namespaceFilter, "All namespaces", data.facets.namespaces);
      setSelectOptions(typeFilter, "All types", data.facets.memory_types);
      setSelectOptions(agentFilter, "All agents", data.facets.agents);
    }
    if (selectedMemoryId) {
      const selectedNode = state.nodeById.get(`memory:${selectedMemoryId}`);
      if (selectedNode) selectNode(selectedNode);
    }
    const suffix = data.truncated ? "+" : "";
    const facetNote = data.facets_truncated ? " · filter list capped" : "";
    const statusText = `${data.memory_count}${suffix} memories${facetNote}`;
    if (!silent || graphChanged || loadStatus.textContent !== statusText) {
      loadStatus.classList.remove("error");
      loadStatus.textContent = statusText;
    }
  } catch (error) {
    if (loadNumber !== state.loadNumber) return;
    if (silent) return;
    loadStatus.classList.add("error");
    loadStatus.textContent = error instanceof Error ? error.message : "The memory graph could not load.";
    emptyState.hidden = false;
    emptyState.querySelector("strong").textContent = "Graph unavailable";
    emptyState.querySelector("span").textContent = loadStatus.textContent;
  } finally {
    if (loadNumber === state.loadNumber) state.loadInFlight = false;
  }
}

let searchTimer = null;
searchInput.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    searchTimer = null;
    loadGraph();
  }, 280);
});
namespaceFilter.addEventListener("change", () => loadGraph());
typeFilter.addEventListener("change", () => loadGraph());
agentFilter.addEventListener("change", () => loadGraph());
resetViewButton.addEventListener("click", () => resetCamera(true));
editMemoryButton.addEventListener("click", () => {
  const node = state.nodeById.get(state.selectedNodeId);
  if (node?.memory) renderInspectorEditor(node);
});
deleteMemoryButton.addEventListener("click", () => {
  const node = state.nodeById.get(state.selectedNodeId);
  if (node?.memory) renderDeleteConfirmation(node);
});
closeInspectorButton.addEventListener("click", closeInspector);

for (const toggle of kindToggles) {
  toggle.addEventListener("click", () => {
    const kind = toggle.dataset.kind;
    if (state.visibleKinds.has(kind)) {
      state.visibleKinds.delete(kind);
    } else {
      state.visibleKinds.add(kind);
    }
    toggle.setAttribute("aria-pressed", String(state.visibleKinds.has(kind)));
    state.temperature = reducedMotion ? 0 : 0.24;
    if (state.selectedNodeId && !state.visibleKinds.has(state.nodeById.get(state.selectedNodeId)?.kind)) {
      closeInspector();
    }
  });
}

canvas.addEventListener("pointerdown", onPointerDown);
canvas.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerup", onPointerUp);
canvas.addEventListener("pointercancel", onPointerUp);
canvas.addEventListener("pointerleave", () => {
  if (!state.pointer) state.hoveredNodeId = null;
});
canvas.addEventListener("wheel", onWheel, { passive: false });
if ("ResizeObserver" in window) {
  new ResizeObserver(resizeCanvas).observe(stage);
} else {
  window.addEventListener("resize", resizeCanvas);
}
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (state.editingNodeId) {
    const node = state.nodeById.get(state.editingNodeId);
    if (node) renderInspectorDetails(node);
    return;
  }
  if (state.deletingNodeId) {
    const node = state.nodeById.get(state.deletingNodeId);
    if (node) renderInspectorDetails(node);
    return;
  }
  closeInspector();
});

async function pollGraph() {
  await loadGraph(null, { merge: true, silent: true });
  window.setTimeout(pollGraph, GRAPH_POLL_INTERVAL_MS);
}

resizeCanvas();
loadGraph().finally(() => {
  window.setTimeout(pollGraph, GRAPH_POLL_INTERVAL_MS);
});
state.animationFrame = requestAnimationFrame(drawGraph);
