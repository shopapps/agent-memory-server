// Throwaway, example-data preview. Reuses the real renderer; never calls the API.
const page = new DOMParser().parseFromString(await (await fetch('graph.html')).text(), 'text/html');
page.querySelectorAll('script').forEach(script => script.remove());
document.body.replaceChildren(...page.body.childNodes);
document.querySelector('#working-memory-link').href = 'http://127.0.0.1:8000/admin/working-memory';
const note = document.createElement('span');
note.className = 'prototype-note';
note.textContent = 'Prototype · example data · saved in this browser only';
document.querySelector('.app-header').append(note);
const toolbar = document.querySelector('.toolbar');
const extras = document.createElement('div');
extras.className = 'extra-filters';
extras.hidden = true;
for (const element of [...toolbar.children].slice(1)) extras.append(element);
toolbar.insertAdjacentHTML('afterbegin', '<button id="views-toggle" class="view-button primary" aria-expanded="true" aria-controls="views-drawer">Views</button><select id="active-view" class="view-button" aria-label="Switch saved view"></select>');
toolbar.insertAdjacentHTML('beforeend', '<button id="filters-toggle" class="view-button" aria-expanded="false">Filters</button>');
toolbar.append(extras);
document.querySelector('.workspace').insertAdjacentHTML('beforeend', `
  <aside id="views-drawer" class="views-drawer" aria-label="Saved views">
    <div class="drawer-heading"><h2>Saved views</h2><button id="hide-views" class="icon-button" aria-label="Close saved views" title="Close saved views"></button></div>
    <p>Close to return to the full map.</p>
    <section><nav id="saved-views" aria-label="Choose saved view"></nav><button id="new-view" class="view-button add-view"><span aria-hidden="true">+</span> Add View</button></section>
    <section><h3>Projects</h3><input id="project-search" type="search" aria-label="Search projects" placeholder="Search projects…"><label class="project-check select-all-projects"><input id="select-all-projects" type="checkbox">All projects</label><div id="project-list"></div>
      <label class="project-check"><input id="include-new" type="checkbox">Include new projects</label><small id="include-help"></small>
    </section>
    <section><label for="view-name">View name</label><input id="view-name" type="text" maxlength="60" value="Work"><button id="save-view" class="view-button primary">Save view</button><p id="view-message" role="status"></p><button id="undo-delete" class="view-button" hidden>Undo delete</button></section>
    <p>View only — stored memories are unchanged.</p>
    <button id="add-example" class="view-row">Try adding an example project</button>
  </aside>`);
document.querySelector('#hide-views').append(document.querySelector('#close-inspector svg').cloneNode(true));
const projects = ['Console', 'Archive API', 'Portal', 'roll20-plugin', 'wildshape'];
const storeKey = 'ams-throwaway-views-preview-v1';
let saved = [
  { name: 'Work', selected: projects.slice(0, 3), known: [...projects], includeNew: false },
  { name: 'Personal', selected: projects.slice(3), known: [...projects], includeNew: false },
];
try { saved = JSON.parse(localStorage.getItem(storeKey)) || saved; } catch { /* Default preview views. */ }
let draft = structuredClone(saved[0] || { name: 'All memories', selected: [...projects], known: [...projects], includeNew: true });
let active = draft.name;
let dirty = false;
let deletedView = null;
const $ = selector => document.querySelector(selector);
const drawer = $('#views-drawer');
function toggleDrawer(open) {
  drawer.hidden = !open;
  $('#views-toggle').setAttribute('aria-expanded', String(open));
  if (!open) $('#views-toggle').focus();
}
$('#views-toggle').onclick = () => toggleDrawer(drawer.hidden);
$('#active-view').onchange = event => selectView(event.target.value);
$('#hide-views').onclick = () => toggleDrawer(false);
window.addEventListener('keydown', event => { if (event.key === 'Escape' && !drawer.hidden) toggleDrawer(false); });
$('#filters-toggle').onclick = () => { extras.hidden = !extras.hidden; $('#filters-toggle').setAttribute('aria-expanded', String(!extras.hidden)); };
function selectedProjects() { return projects.filter(project => draft.selected.includes(project) || (draft.includeNew && !draft.known.includes(project))); }
function refreshGraph() { $('#search-input').dispatchEvent(new Event('input')); }
function selectView(name) {
  draft = name === 'All memories' ? { name, selected: [...projects], known: [...projects], includeNew: true } : structuredClone(saved.find(view => view.name === name));
  active = name; dirty = false; $('#view-message').textContent = ''; render(); refreshGraph();
}
function renderViewPicker() {
  const picker = $('#active-view');
  picker.replaceChildren();
  if (dirty) {
    const pending = new Option(`${draft.name || 'New view'} · unsaved · ${selectedProjects().length} projects`, '');
    pending.disabled = true; pending.hidden = true; picker.append(pending);
  }
  for (const view of [{ name: 'All memories', selected: [...projects], known: [...projects], includeNew: true }, ...saved]) {
    const count = projects.filter(project => view.selected.includes(project) || (view.includeNew && !view.known.includes(project))).length;
    picker.append(new Option(`${view.name} · ${count} projects`, view.name));
  }
  picker.value = dirty ? '' : active;
}
function render() {
  renderViewPicker();
  $('#view-name').value = draft.name;
  $('#undo-delete').hidden = !deletedView;
  $('#include-new').checked = draft.includeNew;
  $('#include-help').textContent = draft.includeNew ? 'New projects appear automatically. Hidden projects stay hidden.' : 'Only show the projects you check.';
  $('#saved-views').replaceChildren();
  for (const name of ['All memories', ...saved.map(view => view.name)]) {
    const button = document.createElement('button'); button.className = 'view-row'; button.textContent = name;
    button.setAttribute('aria-pressed', String(active === name && !dirty));
    button.onclick = () => selectView(name);
    const row = document.createElement('div'); row.className = 'saved-view-row';
    row.append(button);
    if (name !== 'All memories') {
      const remove = document.createElement('button'); remove.className = 'icon-button delete-saved-view';
      remove.setAttribute('aria-label', `Delete ${name}`); remove.title = `Delete ${name}`;
      remove.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';
      remove.onclick = () => deleteView(name);
      row.append(remove);
    }
    $('#saved-views').append(row);
  }
  renderProjects();
}
function renderProjects() {
  const selectedCount = projects.filter(project => selectedProjects().includes(project)).length;
  $('#select-all-projects').checked = projects.length > 0 && selectedCount === projects.length;
  $('#select-all-projects').indeterminate = selectedCount > 0 && selectedCount < projects.length;
  $('#select-all-projects').disabled = projects.length === 0;
  $('#project-list').replaceChildren();
  for (const project of projects.filter(name => name.toLowerCase().includes($('#project-search').value.toLowerCase()))) {
    const label = document.createElement('label'); label.className = 'project-check';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selectedProjects().includes(project);
    check.onchange = () => {
      const selected = new Set(selectedProjects());
      if (check.checked) selected.add(project); else selected.delete(project);
      draft.selected = [...selected]; draft.known = [...projects]; dirty = true; render(); refreshGraph();
    };
    label.append(check, document.createTextNode(project)); $('#project-list').append(label);
  }
}
$('#project-search').oninput = renderProjects;
$('#select-all-projects').onchange = event => {
  draft.selected = event.target.checked ? [...projects] : [];
  draft.known = [...projects];
  dirty = true;
  $('#project-search').value = '';
  render(); refreshGraph();
};
$('#include-new').onchange = event => { draft.selected = selectedProjects(); draft.known = [...projects]; draft.includeNew = event.target.checked; dirty = true; render(); refreshGraph(); };
$('#new-view').onclick = () => {
  draft = { name: '', selected: [], known: [...projects], includeNew: false };
  active = ''; dirty = true;
  $('#project-search').value = '';
  $('#view-message').textContent = '';
  render(); refreshGraph(); $('#view-name').focus();
};
$('#view-name').oninput = event => { draft.name = event.target.value; dirty = true; renderViewPicker(); };
$('#save-view').onclick = () => {
  const name = draft.name.trim();
  if (!name || name === 'All memories') { $('#view-message').textContent = 'Choose a name other than All memories.'; return; }
  draft.name = name; draft.selected = selectedProjects(); draft.known = [...projects];
  const match = saved.findIndex(view => view.name === name);
  const next = [...saved];
  if (match < 0) next.push(structuredClone(draft)); else next[match] = structuredClone(draft);
  if (!persistViews(next)) return;
  active = name; dirty = false; render(); $('#view-message').textContent = `Saved ${name} in this browser.`;
  revealActiveView();
};
function persistViews(next) {
  try { localStorage.setItem(storeKey, JSON.stringify(next)); }
  catch { $('#view-message').textContent = 'Browser storage is unavailable. No changes were saved.'; return false; }
  saved = next;
  return true;
}
function revealActiveView() {
  $('#saved-views [aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
}
function deleteView(name) {
  const view = saved.find(view => view.name === name);
  if (!view) return;
  const index = saved.indexOf(view);
  if (!persistViews(saved.filter(item => item !== view))) return;
  deletedView = { view, index };
  // Keep the current filter so deleting a work view cannot reveal personal memories.
  if (active === name) { active = ''; dirty = true; }
  render();
  $('#view-message').textContent = `Deleted ${view.name}. Memories and current filters are unchanged. Undo is available until you reload or delete another view.`;
}
$('#undo-delete').onclick = () => {
  if (!deletedView) return;
  const { view, index } = deletedView;
  if (saved.some(item => item.name === view.name)) {
    $('#view-message').textContent = `A view called ${view.name} already exists. Delete it before restoring this one.`;
    return;
  }
  const next = [...saved]; next.splice(index, 0, view);
  if (!persistViews(next)) return;
  draft = structuredClone(view); active = view.name; dirty = false; deletedView = null;
  render(); refreshGraph(); revealActiveView();
  $('#view-message').textContent = `Restored ${view.name}.`;
};
$('#add-example').onclick = event => { if (!projects.includes('Example service')) projects.push('Example service'); event.target.disabled = true; event.target.textContent = 'Example service added'; render(); refreshGraph(); };

function exampleGraph(query) {
  const nodes = new Map(), edges = [];
  const add = node => nodes.set(node.id, node);
  const link = (source, target, kind) => edges.push({ id: `${source}:${target}`, source, target, kind });
  let count = 0;
  selectedProjects().forEach((project, p) => {
    const projectId = `project:${project}`;
    for (let i = 0; i < 15; i++) {
      const topic = ['API', 'Testing', 'Deployment', 'Security', 'Caching'][i % 5];
      const entity = ['PHP', 'Laravel', 'JavaScript', 'Redis', 'Docker'][(i + p) % 5];
      const text = `${project}: ${topic} example ${i + 1} uses ${entity}.`;
      if (query && !text.toLowerCase().includes(query.toLowerCase())) continue;
      count++;
      add({ id: projectId, kind: 'project', label: project, value: project, count: 15 });
      const id = `memory:${project}:${i}`;
      const memory = { id: `${project}:${i}`, text, project_id: project, namespace: 'example', memory_type: 'semantic', topics: [topic], entities: [entity], metadata: {}, created_at: '2026-09-15T08:00:00Z', updated_at: '2026-09-15T08:00:00Z', extracted_from: [] };
      add({ id, kind: 'memory', label: text, value: memory.id, memory, project_label: project });
      add({ id: `topic:${topic}`, kind: 'topic', label: topic, value: topic, count: 9 });
      add({ id: `entity:${entity}`, kind: 'entity', label: entity, value: entity, count: 9 });
      link(id, projectId, 'belongs_to'); link(id, `topic:${topic}`, 'tagged'); link(id, `entity:${entity}`, 'mentions');
    }
  });
  return { nodes: [...nodes.values()], edges, memory_count: count, result_limit: 250, truncated: false, facets_truncated: false, facets: { projects: [], namespaces: [], memory_types: [], agents: [] } };
}
// All renderer requests terminate here. No request can reach the live server.
window.fetch = async (input) => {
  const url = new URL(input, location.href);
  if (url.pathname === '/v1/admin/memories/graph') return Response.json(exampleGraph(url.searchParams.get('search')));
  if (url.pathname.endsWith('/history')) return Response.json({ entries: [] });
  return new Response('Unavailable in example-data preview', { status: 403 });
};
render();
await import('./graph.js');
