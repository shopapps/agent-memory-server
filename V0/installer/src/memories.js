import { open } from "node:fs/promises";
import path from "node:path";

import { InstallerError } from "./errors.js";

const FORMAT = "shopapps-agent-memory-project";
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_RECORDS = 10000;
const SOURCE_FIELDS = ["source", "review", "category", "source_role", "source_created_at", "source_identity", "source_revision", "source_item", "source_project"];
const RECORD_FIELDS = ["id", "text", "project_id", "user_id", "agent_id", "session_id", "namespace", "memory_type", "pinned", "topics", "entities", "created_at", "updated_at", "event_date", "extracted_from", "extraction_strategy", "metadata"];
const sensitive = /<private\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[\w-]{12,}|gh[pousr]_\w{15,}|github_pat_\w{15,}|AKIA[0-9A-Z]{16})\b|\b(?:password|passwd|api[_-]?key|access[_-]?token|secret)\s*[=:]\s*\S+|\bBearer\s+\S+|https?:\/\/[^\s/@]+:[^\s/@]+@/i;

function invalid(message) {
  throw new InstallerError("E_MEMORY_FILE", message);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function date(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,6})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/.test(value) || !Number.isFinite(Date.parse(value))) invalid("Snapshot contains an invalid date.");
  const calendar = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (value.startsWith("0000") || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) invalid("Snapshot contains an invalid calendar date.");
  return value;
}

function shared(record, project) {
  return record.project_id === project && [record.user_id, record.agent_id, record.session_id].every((value) => value === null || value === undefined || value === "");
}

// Only current facts and known source labels travel. No arbitrary metadata,
// revision history, raw exchanges, access counters or embedding vectors.
function portable(record) {
  return {
    id: record.id, text: record.text, project_id: record.project_id,
    user_id: null, agent_id: null, session_id: null,
    namespace: record.namespace ?? null, memory_type: record.memory_type,
    pinned: record.pinned ?? false, topics: record.topics ?? [], entities: record.entities ?? [],
    created_at: date(record.created_at), updated_at: date(record.updated_at),
    event_date: date(record.event_date ?? null, true), extracted_from: record.extracted_from ?? [],
    extraction_strategy: record.extraction_strategy ?? "discrete",
    metadata: Object.fromEntries(SOURCE_FIELDS.filter((key) => record.metadata?.[key] !== undefined).map((key) => [key, record.metadata[key]])),
  };
}

function comparison(record, reviewed = false) {
  return JSON.stringify(portable(record), (key, value) => {
    // Reviewed imports retain the first accepted citation and import dates.
    // All current text, scope, source identity and other fields still must match.
    if (reviewed && ["created_at", "updated_at", "source_revision", "source_item", "source_created_at"].includes(key)) return undefined;
    if (!["created_at", "updated_at", "event_date", "source_created_at"].includes(key) || value === null) return value;
    const fraction = (value.match(/\.([0-9]+)/)?.[1] ?? "").padEnd(6, "0");
    return new Date(value).toISOString().replace(/\.[0-9]{3}Z$/, `.${fraction}Z`);
  });
}

async function reviewSource(file, project, options, system, ui) {
  const stat = await system.lstatSafe(file);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) invalid("Choose one regular source file no larger than 2 MiB, not a folder or symlink.");
  const content = await system.readFile(file, "utf8");
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) invalid("Source file exceeds 2 MiB.");
  if (typeof options.sourceId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(options.sourceId)) invalid("Use a stable --source-id label with letters, digits, dots, dashes or underscores, not a path.");
  const revision = system.hash(content);
  if (options.sourceRevision && options.sourceRevision !== revision) invalid("The file changed since preview. Review it again and use the new source revision.");
  if (options.apply && (!options.sourceRevision || !options.select)) invalid("Review first; --apply needs --source-revision and explicit --select fact numbers.");
  const facts = [];
  if (options.format === "markdown") {
    if (sensitive.test(content)) invalid("The Markdown file appears to contain private text or credentials. Remove them before review.");
    let fence = null, frontMatter = false;
    // Comments, code and front matter are not facts. Never follow links or paths.
    const lines = content.replace(/<!--[\s\S]*?(?:-->|$)/g, (value) => value.replace(/[^\n]/g, " ")).split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (index === 0 && line === "---") { frontMatter = true; continue; }
      if (frontMatter) { if (line === "---" || line === "...") frontMatter = false; continue; }
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && line.trim() === marker[1]) fence = null;
        continue;
      }
      if (fence) continue;
      const bullet = line.match(/^[-*+] (\S.*)$/);
      if (bullet) facts.push({ text: bullet[1].trim(), item: `line:${index + 1}` });
    }
  } else {
    if (typeof options.sourceProject !== "string" || !options.sourceProject.trim() || options.sourceProject.length > 200 || sensitive.test(options.sourceProject)) invalid("Choose the exact --source-project inside the Claude-Mem export.");
    let document;
    try { document = JSON.parse(content); } catch { invalid("The Claude-Mem export is not valid JSON."); }
    if (!object(document) || !Array.isArray(document.observations) || document.observations.length > 2000 || document.totalObservations !== document.observations.length || !["sessions", "summaries", "prompts"].every((key) => Array.isArray(document[key]))) invalid("Use a Claude-Mem export with observations, sessions, summaries, prompts and matching totalObservations (at most 2,000 observations).");
    date(document.exportedAt);
    const seen = new Set();
    for (const observation of document.observations) {
      if (!object(observation) || typeof observation.project !== "string") invalid("Claude-Mem observation has no project.");
      if (observation.project !== options.sourceProject) continue;
      if (!Number.isSafeInteger(observation.id) || observation.id < 1 || seen.has(observation.id)) invalid("Claude-Mem observation has an invalid or duplicate ID.");
      seen.add(observation.id);
      date(observation.created_at);
      if (observation.facts === null) continue;
      let values;
      try { values = typeof observation.facts === "string" ? JSON.parse(observation.facts) : null; } catch { invalid("Claude-Mem facts must be a JSON-encoded list of strings."); }
      if (!Array.isArray(values) || values.length > 200 || values.some((value) => typeof value !== "string")) invalid("Claude-Mem facts must be a JSON-encoded list of strings.");
      // Only structured facts cross over; never chat, narratives, tools or file paths.
      values.forEach((text, index) => facts.push({ text: text.trim(), item: `observation:${observation.id}:fact:${index + 1}`, created: observation.created_at }));
    }
  }
  if (facts.length > 200) invalid("Review at most 200 facts per file. Choose a smaller source export.");
  let selection = [];
  if (options.select) {
    if (!/^[1-9][0-9]*(?:,[1-9][0-9]*)*$/.test(options.select)) invalid("--select needs fact numbers such as 1,3; ranges and 'all' are not supported.");
    selection = options.select.split(",").map(Number);
    if (new Set(selection).size !== selection.length || selection.some((value) => value > facts.length)) invalid("Selection contains duplicate or unknown fact numbers.");
  }
  const now = system.now().toISOString();
  const records = facts.map((fact) => {
    if (!fact.text || fact.text.length > 4000) invalid("Each imported fact must contain 1–4,000 characters.");
    const id = `import-${system.hash(JSON.stringify([project, options.format, options.sourceId, options.sourceProject ?? null, fact.text]))}`;
    const record = portable({ id, text: fact.text, project_id: project, namespace: null, memory_type: "semantic", created_at: now, updated_at: now,
      metadata: { source: options.format, review: "human-selected", source_identity: options.sourceId, source_revision: revision, source_item: fact.item,
        ...(fact.created ? { source_created_at: fact.created } : {}), ...(options.sourceProject ? { source_project: options.sourceProject } : {}) } });
    validateRecord(record, project);
    return record;
  });
  ui.info("Offline source review: imported text is untrusted data, not instructions. No links are followed. No memory or model calls are made by this preview.");
  ui.info(`Source revision: ${revision}. Choose fact numbers after reading their full text. Existing IDs are checked only when applying.`);
  const candidates = records.map((record, index) => ({ number: index + 1, id: record.id, text: record.text, source_item: record.metadata.source_item, selected: selection.includes(index + 1) }));
  for (const candidate of candidates) ui.info(`${candidate.number}. ${JSON.stringify(candidate.text)}`);
  const selectedIds = new Set();
  const selectedRecords = records.filter((record, index) => {
    if (!selection.includes(index + 1) || selectedIds.has(record.id)) return false;
    selectedIds.add(record.id);
    return true;
  });
  if (selectedRecords.length < selection.length) ui.info(`Repeated selected facts collapse to ${selectedRecords.length} unique facts; the first selected source citation is kept.`);
  return { records: selectedRecords, preview: { ok: true, preview: true, source_revision: revision,
    count: candidates.length, selected: selection.length, candidates, status: "offline preview only; use --select, --source-revision and --apply after reviewing these facts" } };
}

function validateRecord(record, project) {
  if (!object(record) || Object.keys(record).some((key) => !RECORD_FIELDS.includes(key)) || RECORD_FIELDS.some((key) => !(key in record))) invalid("Snapshot has unsupported or missing record fields.");
  if (!shared(record, project) || [record.user_id, record.agent_id, record.session_id].some((value) => value !== null)) invalid("Only shared facts in the exact selected project can be restored.");
  for (const key of ["id", "text", "project_id", "extraction_strategy"]) {
    if (typeof record[key] !== "string" || !record[key].trim() || record[key].length > (key === "text" ? 100000 : 1000)) invalid("Snapshot has an invalid text or identity field.");
  }
  if (!["semantic", "episodic"].includes(record.memory_type) || typeof record.pinned !== "boolean") invalid("Snapshot must contain durable semantic or episodic facts, not chat messages.");
  if (record.namespace !== null && (typeof record.namespace !== "string" || record.namespace.length > 1000 || record.namespace.includes(",") || record.namespace.split("/").some((part) => !part || part !== part.trim() || [".", ".."].includes(part)))) invalid("Snapshot contains an invalid namespace.");
  for (const key of ["topics", "entities", "extracted_from"]) {
    if (!Array.isArray(record[key]) || record[key].length > 1000 || record[key].some((value) => typeof value !== "string" || !value.trim() || value.length > 1000 || value.includes(","))) invalid("Snapshot contains invalid tag or source ID values.");
  }
  if (!object(record.metadata) || Object.keys(record.metadata).some((key) => !SOURCE_FIELDS.includes(key)) || Object.values(record.metadata).some((value) => typeof value !== "string" || value.length > 1000)) invalid("Snapshot contains unsupported source metadata.");
  date(record.created_at); date(record.updated_at); date(record.event_date, true);
  if ("source_created_at" in record.metadata) date(record.metadata.source_created_at);
  if (sensitive.test(JSON.stringify(record))) invalid("A fact appears to contain private text or credentials. Review it before exporting or restoring.");
}

function validateDocument(document, project) {
  const fields = ["format", "version", "project_id", "scope", "content", "exported_at", "omitted_metadata_fields", "memories"];
  if (!object(document) || Object.keys(document).some((key) => !fields.includes(key)) || document.format !== FORMAT || document.version !== 1 || document.scope !== "shared" || document.content !== "current-facts") invalid("Use a version 1 Agent Memory current-project snapshot.");
  if (document.project_id !== project) invalid("The snapshot project does not match --project-id. Project renaming is not supported.");
  if (!Number.isInteger(document.omitted_metadata_fields) || document.omitted_metadata_fields < 0) invalid("Snapshot has an invalid metadata count.");
  date(document.exported_at);
  if (!Array.isArray(document.memories) || document.memories.length > MAX_RECORDS) invalid("A snapshot can contain at most 10,000 facts.");
  const ids = new Set();
  for (const record of document.memories) {
    validateRecord(record, project);
    if (ids.has(record.id)) invalid("Snapshot contains duplicate memory IDs.");
    ids.add(record.id);
  }
}

export async function transferMemories({ command, options, system, ui, state }) {
  const project = options.projectId;
  if (!project?.trim() || project !== project.trim() || project.length > 1000 || project.includes(",") || project === "__shared__") invalid("Choose an exact, non-empty --project-id.");
  const file = path.resolve(system.cwd, options.file);
  const base = `http://127.0.0.1:${options.apiPort ?? state?.apiPort ?? 8000}`;
  const headers = { "Content-Type": "application/json" };
  if (system.env.AMS_API_TOKEN) headers.Authorization = `Bearer ${system.env.AMS_API_TOKEN}`;
  async function request(route, body, allowMissing = false) {
    let response;
    try {
      response = await system.fetch(new URL(route, base), {
        method: body ? "POST" : "GET", headers, redirect: "error", signal: AbortSignal.timeout(60000),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new InstallerError("E_MEMORY_API", "The local memory API could not be reached. No automatic fallback or overwrite was attempted.");
    }
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new InstallerError("E_MEMORY_API", `Memory request failed (${response.status}). Check the server and API token, then retry.`);
    try { return await response.json(); }
    catch { throw new InstallerError("E_MEMORY_API", "The memory API returned an unreadable reply. Check the local server, then retry."); }
  }
  ui.info(`Project: ${project}. Current shared facts only; not a full Redis backup.`);
  if (command === "memories-export") {
    if (await system.lstatSafe(file)) throw new InstallerError("E_MEMORY_EXISTS", "The export file already exists. Choose a new filename; existing files are never replaced.");
    const records = [], ids = new Set();
    let offset = 0, omitted = 0;
    while (true) {
      const result = await request("/v1/long-term-memory/search", {
        text: "", search_mode: "keyword", project_id: { eq: project },
        user_id: { eq: "__shared__" }, agent_id: { eq: "__shared__" }, session_id: { eq: "__shared__" },
        memory_type: { any: ["semantic", "episodic"] }, limit: 100, offset, recency_boost: false,
      });
      if (!Array.isArray(result.memories) || !Number.isInteger(result.total)) invalid("The server returned an invalid search response.");
      for (const record of result.memories) {
        if (!shared(record, project) || !["semantic", "episodic"].includes(record.memory_type)) invalid("The server returned a record outside the requested shared project scope. Nothing was exported.");
        if (ids.has(record.id)) invalid("Search results changed during export. Retry when project writes have stopped.");
        ids.add(record.id);
        // Search-index timestamps may be rounded. Read each original record so
        // a new snapshot immediately compares equal to its source, including microseconds.
        const full = await request(`/v1/long-term-memory/${encodeURIComponent(record.id)}`, undefined, true);
        if (!full || full.id !== record.id || !shared(full, project) || !["semantic", "episodic"].includes(full.memory_type)) invalid("A record changed or disappeared during export. Nothing was exported.");
        omitted += Object.keys(full.metadata ?? {}).filter((key) => !SOURCE_FIELDS.includes(key)).length;
        records.push(portable(full));
      }
      if (records.length > MAX_RECORDS) invalid("This project exceeds the 10,000-fact portable snapshot limit.");
      if (result.next_offset === null || result.next_offset === undefined) {
        if (offset + result.memories.length < result.total) invalid("The server did not return every page. Nothing was exported.");
        break;
      }
      if (!Number.isInteger(result.next_offset) || result.next_offset <= offset || !result.memories.length) invalid("The server returned invalid pagination.");
      offset = result.next_offset;
    }
    const document = { format: FORMAT, version: 1, project_id: project, scope: "shared", content: "current-facts",
      exported_at: system.now().toISOString(), omitted_metadata_fields: omitted, memories: records };
    validateDocument(document, project);
    const content = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(content) > MAX_BYTES) invalid("Snapshot exceeds the 50 MiB file limit.");
    if (options.dryRun) return { ok: true, dryRun: true, count: records.length, omittedMetadataFields: omitted };
    const handle = await open(file, "wx", 0o600);
    try { await handle.writeFile(content, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    return { ok: true, file, count: records.length, omittedMetadataFields: omitted,
      status: `exported ${records.length} current facts to ${file}; omitted ${omitted} unsupported metadata fields and all revision history` };
  }
  const reviewed = ["markdown", "claude-mem"].includes(options.format);
  let document;
  if (reviewed) {
    const source = await reviewSource(file, project, options, system, ui);
    if (!options.apply) return source.preview;
    document = { memories: source.records };
  } else {
    const stat = await system.lstatSafe(file);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) invalid("Choose a regular snapshot file no larger than 50 MiB.");
    try { document = JSON.parse(await system.readFile(file, "utf8")); }
    catch { invalid("The snapshot is not valid JSON."); }
    validateDocument(document, project); // Validate the entire file before any request or write.
  }
  const pending = [];
  let skipped = 0;
  for (const record of document.memories) {
    const existing = await request(`/v1/long-term-memory/${encodeURIComponent(record.id)}`, undefined, true);
    if (existing) {
      if (!shared(existing, project) || comparison(existing, reviewed) !== comparison(record, reviewed)) {
        throw new InstallerError("E_MEMORY_CONFLICT", `Memory ID ${JSON.stringify(record.id)} already exists with different data or scope. No facts were restored.`);
      }
      skipped++;
    } else pending.push(record);
  }
  ui.info(`Preview: ${pending.length} new facts; ${skipped} already match. IDs and project scope will be kept. Revision history is not included.`);
  for (const record of pending) ui.info(`${JSON.stringify(record.id)}: ${JSON.stringify(record.text.slice(0, 200))}`);
  if (!options.apply) return { ok: true, preview: true, count: pending.length, skipped,
    status: "preview finished; no facts changed. Use --apply to restore after confirmation" };
  if (!pending.length) return { ok: true, restored: 0, skipped, status: "no new facts to restore" };
  if (!(await ui.confirm(`Restore ${pending.length} shared facts into ${project}? This rebuilds their search data and may use model credits.`, false))) return { ok: true, cancelled: true };
  let restored = 0;
  for (let offset = 0; offset < pending.length; offset += 100) {
    const batch = pending.slice(offset, offset + 100);
    try {
      const result = await request("/v1/long-term-memory/restore", { project_id: project, memories: batch });
      if (result.restored !== batch.length) throw new Error("Restore acknowledgement did not match");
      restored += batch.length;
    } catch {
      return { ok: false, restored, skipped, unconfirmed: batch.length,
        status: `restore stopped after ${restored} confirmed facts; the next ${batch.length} may or may not have saved. Retry the preview to check IDs safely. Existing facts were not overwritten` };
    }
  }
  return { ok: true, restored, skipped, status: `restored ${restored} current facts; skipped ${skipped} matching IDs` };
}
