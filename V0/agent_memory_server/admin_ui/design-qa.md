# Saved-view drawer preview

This is a throwaway, example-data preview, not a production feature.

Run from the repository root:

```sh
source V0/.venv/bin/activate
python -m http.server 8012 --bind 127.0.0.1 --directory V0/agent_memory_server/admin_ui
```

Open http://127.0.0.1:8012/views-prototype.html.
The three `views-prototype.*` files reuse the existing graph HTML, CSS and renderer.
Renderer fetches are intercepted with example data; live API writes are not possible.
Saved project selections use the isolated browser key `ams-throwaway-views-preview-v1`.
Other filters are existing renderer controls, not part of saved views in this preview.

## Visual check — 2026-09-15

- Source: the approved toolbar-and-drawer mockup shared during design review.
- Implementation: browser-rendered captures of the preview URL, inline in this task under “Verify sidebar spacing after adjustment”. No separate screenshot file was saved.
- Source approximately 1488 × 1056; comparison viewport 1488 × 1056, CSS pixels, desktop, dark theme, Work selected, drawer open.
- Source and implementation were emitted together in the same comparison call. Full view and readable drawer controls were checked; separate crops were unnecessary at this size.
- Fonts: existing system-font stack, readable labels and heading hierarchy. Text-only controls replace decorative icons in this functional preview.
- Layout: overlay drawer below toolbar; stable map area when hidden; active view remains in toolbar.
- Colours: existing navy, purple selection and graph colours reused.
- Graph: actual renderer with a smaller example dataset, not a screenshot approximation. Node positions and size therefore differ from the illustrative source.
- Copy: saved views, project list, include-new-projects, view name and save controls retained. Preview/storage notice replaces illustrative notice.

## Checks and iteration

- Initial comparison: adding another saved view pushed Save partly below the desktop fold.
- Fix: bounded the saved-view list and reduced section padding.
- Second paired comparison: Save fully visible, with scrolling available for longer lists. No remaining blocking layout issue.
- Views/Hide toggle tested; Work stays active while drawer is hidden.
- Custom Review demo saved with two projects (30 memories), then recalled after reload.
- Include new projects enabled: adding Example service yielded four selected projects (60 memories), while personal projects stayed unchecked.
- Returning to saved Work restored three projects (45 memories), excluding Example service.
- Small-screen check: 390 × 844, document width 390; drawer scrolls within viewport. The direct browser screenshot was used because the wrapper screenshot was scaled incorrectly.
- Browser error/warning log: empty.
- JavaScript module syntax check passed. Production server tests not run: no production code changed.
- Saving now scrolls the selected name into view immediately; checked with a list longer than its visible area.
- Delete view removes only the saved filter, keeping the current project selection. Undo restores it until reload or another deletion. Save, delete, undo and reload were checked in the browser with a separate test view.

## Follow-up polish

Small decorative icons and a slide animation can be added when moving the chosen design into the app. This preview does not implement server-side saved views, rename controls, or full saved-filter rules.

final result: passed
