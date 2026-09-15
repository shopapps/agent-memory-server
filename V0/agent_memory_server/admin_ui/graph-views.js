export function createGraphViews({ loadGraph, workingMemoryUserId, initialParameters }) {
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
    <p>Choose a view to edit its projects.</p>
    <section><nav id="saved-views" aria-label="Choose saved view"></nav><button id="new-view" class="view-button add-view"><span aria-hidden="true">+</span> Add View</button></section>
    <section><h3>Projects</h3><input id="project-search" type="search" aria-label="Search projects" placeholder="Search projects…"><label class="project-check select-all-projects"><input id="select-all-projects" type="checkbox">All projects</label><div id="project-list"></div>
      <label class="project-check"><input id="include-new" type="checkbox">Include new projects</label><small id="include-help"></small>
    </section>
    <section><label for="view-name">View name</label><input id="view-name" type="text" maxlength="60" value="Work"><button id="save-view" class="view-button primary">Save view</button><p id="view-message" role="status"></p><button id="undo-delete" class="view-button" hidden>Undo delete</button></section>
    <p>View only — stored memories are unchanged.</p>

  </aside>`);
document.querySelector('#hide-views').append(document.querySelector('#close-inspector svg').cloneNode(true));
let projects = [];
let projectFacets = new Map();
const projectLabel = key => {
  const facet = projectFacets.get(key);
  const [field, value] = JSON.parse(key);
  const duplicate = facet && [...projectFacets.values()].filter(item => item.label === facet.label).length > 1;
  return duplicate ? `${value} (${field === 'namespace' ? 'namespace' : 'project'})` : facet?.label || value;
};
const storeKey = `ams-graph-views-v1:${workingMemoryUserId || 'local'}`;
let saved = [];
let active = 'All memories';
try {
  const stored = JSON.parse(localStorage.getItem(storeKey));
  if (stored && Array.isArray(stored.views)) {
    saved = stored.views.filter(view => typeof view.name === 'string' && view.name && view.name !== 'All memories' && Array.isArray(view.selected) && Array.isArray(view.known) && [...view.selected, ...view.known].every(key => { try { const pair = JSON.parse(key); return Array.isArray(pair) && pair.length === 2 && ['project_id', 'namespace'].includes(pair[0]) && typeof pair[1] === 'string'; } catch { return false; } }));
    if (saved.some(view => view.name === stored.active)) active = stored.active;
  }
} catch { /* Keep the built-in view if storage is unavailable. */ }
let draft = structuredClone(saved.find(view => view.name === active) || { name: 'All memories', selected: [], known: [], includeNew: true });
if (initialParameters.get('project_id')) {
  const key = JSON.stringify(['project_id', initialParameters.get('project_id')]);
  draft = { name: 'Linked project', selected: [key], known: [key], includeNew: false };
  active = '';
}
let dirty = !active;
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
function selectedProjects() { return [...new Set([...projects, ...draft.selected])].filter(project => draft.selected.includes(project) || (draft.includeNew && !draft.known.includes(project))); }
function refreshGraph() { loadGraph(); }
function selectView(name) {
  draft = name === 'All memories' ? { name, selected: [...projects], known: [...projects], includeNew: true } : structuredClone(saved.find(view => view.name === name));
  active = name; dirty = false; $('#view-message').textContent = ''; render(); refreshGraph();
  try { localStorage.setItem(storeKey, JSON.stringify({ views: saved, active })); } catch { /* Selection still works without storage. */ }
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
  for (const project of projects.filter(name => projectLabel(name).toLowerCase().includes($('#project-search').value.toLowerCase()))) {
    const label = document.createElement('label'); label.className = 'project-check';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selectedProjects().includes(project);
    check.onchange = () => {
      const selected = new Set(selectedProjects());
      if (check.checked) selected.add(project); else selected.delete(project);
      draft.selected = [...selected]; draft.known = [...projects]; dirty = true; render(); refreshGraph();
    };
    label.append(check, document.createTextNode(projectLabel(project))); $('#project-list').append(label);
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
  try { localStorage.setItem(storeKey, JSON.stringify({ views: next, active: next.some(view => view.name === draft.name) ? draft.name : active })); }
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



function updateFacets(facets) {
  for (const facet of facets) projectFacets.set(JSON.stringify([facet.field, facet.value]), facet);
  projects = [...projectFacets.keys()];
  render();
}
async function loadData(parameters) {
  const snapshot = structuredClone(draft);
  async function request(params) {
    const response = await fetch(`/v1/admin/memories/graph?${params}`);
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Sign in is needed to load memory data.' : `The memory graph could not load (${response.status}).`);
    return response.json();
  }
  const overviewParams = new URLSearchParams(parameters);
  overviewParams.delete('project_id'); overviewParams.delete('project_namespace');
  const overview = await request(overviewParams);
  for (const facet of overview.facets.projects) projectFacets.set(JSON.stringify([facet.field, facet.value]), facet);
  projects = [...projectFacets.keys()];
  if (snapshot.name === 'All memories' && snapshot.includeNew) return overview;
  const chosen = [...new Set([...projects, ...snapshot.selected])].filter(key => snapshot.selected.includes(key) || (snapshot.includeNew && !snapshot.known.includes(key)));
  const nodes = new Map(), edges = new Map();
  let truncated = false;
  // Fetch each chosen scope before combining, rather than filtering a capped all-project result.
  for (const key of chosen) {
    const [field, value] = JSON.parse(key);
    const params = new URLSearchParams(overviewParams);
    params.set(field === 'namespace' ? 'project_namespace' : 'project_id', value);
    if (field === 'namespace') {
      const separator = projectFacets.get(key)?.separator || '/';
      params.set('project_separator', separator);
      const namespace = params.get('namespace');
      if (namespace && namespace !== value && !namespace.startsWith(value + separator)) continue;
    }
    const data = await request(params);
    data.nodes.forEach(node => nodes.set(node.id, node));
    data.edges.forEach(edge => edges.set(edge.id, edge));
    truncated ||= data.truncated;
  }
  return { ...overview, nodes: [...nodes.values()], edges: [...edges.values()], memory_count: [...nodes.values()].filter(node => node.kind === 'memory').length, truncated };
}
render();
return { updateFacets, loadData };

}
