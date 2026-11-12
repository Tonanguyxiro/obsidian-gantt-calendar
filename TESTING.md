# gantt-calendar — testing in real Obsidian

Workspace-wide setup (launching Obsidian, the two test vaults, CLI basics, general pitfalls) is in the workspace `../AGENTS.md`. This file only covers gantt-calendar.

Plugin id: `gantt-calendar`. Main view type: `gantt-calendar-view`. Sidebar view type: see `src/GCSidebarView.ts`.

## 1. Build → deploy → reload

```bash
npx jest && npx eslint .          # 0 errors required
npm run build                     # tsc + esbuild → main.js / styles.css (not copied automatically)
for v in dev-example-vault dev-real-vault; do
  cp main.js manifest.json styles.css ../$v/.obsidian/plugins/gantt-calendar/
  obsidian vault=$v plugin:reload id=gantt-calendar
done
obsidian vault=dev-real-vault dev:errors   # "No errors captured."
```

A reload closes the calendar view. Re-open it with `obsidian vault=<v> command id=gantt-calendar:open-calendar-view`, or:

```bash
obsidian vault=<v> eval code="(async()=>{let l=app.workspace.getLeavesOfType('gantt-calendar-view')[0];if(!l){await app.commands.executeCommandById('gantt-calendar:open-calendar-view');await new Promise(r=>setTimeout(r,900));l=app.workspace.getLeavesOfType('gantt-calendar-view')[0]}app.workspace.revealLeaf(l);app.workspace.setActiveLeaf(l)})()"
```

## 2. Driving the plugin

```bash
# switch view: Day | Week | Month | Year | Tasks | Gantt. Use the toolbar buttons of the main view only
# (the mobile dock has hidden buttons with the same names). Select by index — labels change with the language:
obsidian eval code="document.querySelectorAll('.gantt-calendar-app .gc-toolbar__view-selector-btn')[1].click()"   # 0 Day … 5 Gantt
# plugin state
obsidian eval code="JSON.stringify(app.plugins.plugins['gantt-calendar'].taskCache.getAllTasks().map(t=>t.description))"
# change a setting and refresh
obsidian eval code="(async()=>{const p=app.plugins.plugins['gantt-calendar'];p.settings.fileTaskViews.month.groupTasks=true;await p.saveSettings();p.refreshCalendarViews()})()"
```

Interactions:

- **Single / double click a card**: dispatch `click`, `click`, `dblclick` on `.gc-task-card__text`, then look for `.gc-edit-task-modal`.
- **Week/day drag & drop**: `dragstart` on the card with `data-task-id` → `dragover` ×n and `drop` on `.gc-week-view__day-col[data-day-idx]` with `clientY = column top + minutes/60 × 50 + 5` → `dragend`; then read the line back with `app.vault.read()`. Time-slot items have ids ending in `#slot`.
- **Gantt drag**: take the centre of `[data-task-bar="<id>"] .task-bar`, `pointerdown` on the bar, `pointermove`s and `pointerup` on `activeDocument` (40 px = 1 day), wait ~800 ms, read the file. File rows have id `file:<path>`.
- **File-task hover card**: `document.querySelector('[data-file-task="<path>"]').click()`.
- **Collapse a file row in Gantt**: `click` on `.gc-gantt-view__collapse-toggle`.
- **Scroll containers (desktop)**: the toolbar never scrolls; each view scrolls only its body — Day `.gc-day-view__section--tasks > .gc-day-canvas__body` (title + All-Day fixed), Week `.gc-week-view__tasks-grid` (day headers + All-Day row sticky), Month `.gc-view--month` (weekday row sticky), Year/Tasks `.calendar-content`, Gantt `.calendar-content.gantt-mode`. On phones the app root scrolls as a whole ("waterfall", `App.tsx`). Set `scrollTop` on these, and check header `getBoundingClientRect().top` is unchanged after scrolling.

## 3. Mandatory UI checks (scripts in `tools/`)

After touching cards, time blocks, bars, labels, the sidebar or the task dialog, run these in **every** view (Day / Week / Month / Year / Tasks / Gantt, plus the file-task hover card) at 1600×1000 and at a narrow size:

```bash
obsidian vault=<v> eval code="$(cat tools/check-timeblock-overlap.js)"   # {"overlaps":[]}  — time label vs. block text
obsidian vault=<v> eval code="$(cat tools/check-squeezed-text.js)"       # "squeezed":[]    — text squeezed to a sliver / clipped
obsidian vault=<v> eval code="$(cat tools/check-card-layout.js)"         # "mixed":[] and "duplicateTags":[]
obsidian vault=<v> eval code="$(cat tools/check-modal-overflow.js)"      # "issues":[]      — task dialog + When popover overflow; run with the dialog open, popover closed and open, both tabs
```

Add new text elements to the selectors when you add a new card type. Sample sizes to include: 15 / 30 / 60 / 180-minute blocks, location/tags/long titles, narrow lanes from overlapping events, and a ≈400px split pane (two-column layout).

## 4. Fixtures (`dev-example-vault/GC QA/`)

Plugin settings in that vault: `globalTaskFilter` = `#task` (fixture/scratch task lines need it), `fileTaskFolder` empty, `dailyNoteSource` = `notebook-navigator`, both file-task sources (`fileTaskIncludeDated`, `fileTaskIncludeTaskFiles`) on, `fileTaskExcludeDailyNotes` on. Notebook Navigator: integration mode `notebook-navigator`, root `GC QA/Journal`, pattern `[Daily]/YYYY-MM-DD`.

| File | Covers |
| --- | --- |
| `Inline tasks.md` | ⏳-only tasks (all day / `09:00 - 10:30` range prefix / `14:00` single-time prefix); tag filters `#project-x #📌 #a/b-c`; link rendering `[[Alpha#目标]]`, `[[Design\|设计稿]]`; ⏳+📅 uses 📅; "月视图撑高 A–D" (many tasks on one day); "起止带时刻" / "起止仅日期" (start/due plus ⏳ plus a time prefix) |
| `Tasks interop.md` | lines written by the Tasks plugin |
| `Projects/Alpha/Alpha.md` | folder note (project link target) |
| `Projects/Alpha/Design.md`, `Build.md` | file-based tasks with `project: "[[Alpha\|Alpha 项目]]"` / `"[[Alpha]]"`, timed and untimed tasks; Design has `tags: project/alpha` |
| `Loose doc.md` | file-based task without a project (bottom of the Gantt file section) |
| `Journal/Daily/2026-10-19.md` | daily note under Notebook Navigator rules (embedded on the right of the Day view); its task tests "exclude daily notes" |

Never edit fixture lines to test write-back: the "Edit task" command even adds `#task` to checkbox lines that lack it. Copy lines into a scratch note (and delete it afterwards). `dev-real-vault` has many more tags and tasks — good for density/tag-tree tests — but only ever in a temporary folder.

### Acceptance checklist

1. Month/week/day: ⏳-only tasks appear on the scheduled day; prefixed ones in their time slot without showing the prefix; no tags in the task text; links show as "Alpha > 目标" and "设计稿".
2. Dragging a prefixed task (week block or Gantt bar) changes only ⏳ and the time prefix — no new 🛫/📅; a single-time prefix stays single-time.
3. Day view right panel title `2026-10-19`, content from `GC QA/Journal/Daily/2026-10-19.md`.
4. Purple file bars in month/week/day; single click opens the hover card (project, date range, tasks), double click opens the file; with "group by file" the file's tasks leave the calendar, timed ones stay on the week/day timeline.
5. Gantt: "file timeline" grouped by project (project name is a link showing the alias), projectless files at the bottom; "task timeline" below; with grouping, tasks are indented under their file row. Grouped rows are shorter (28 px row / 16 px bar); file rows with grouped tasks have a collapse toggle; collapsed rows show the hidden count; `settings.ganttCollapsedFileTasks` stores collapsed files; horizontal scroll position is kept. Dragging a file bar rewrites frontmatter `start`/`end`.
6. Double click on a card/bar opens the edit dialog with the line's real fields (⏳-only tasks: Start/Due empty, When = Day).
7. Month view: rows grow with content (at 1100×700 `.gc-view--month` has `scrollHeight > clientHeight`); spans and single-day items share one lane set (`.gc-month-view__span-bar`, single-day with `--day`); single-day items sit right under the bars above them; no "+N more".
8. Year view: after opening or changing year, the current month card (`[data-month="<m>"]`) is visible; today has a red ring.
9. Start/due only carry dates; time slots (⏳ + prefix) carry times. The "起止带时刻" legacy fixture still shows as a 09:00–11:00 slot on the 20th in the week view (`top:450px; height:100px`) and migrates to `prefix + ⏳ + date-only 🛫/📅` after any edit through the plugin; "起止仅日期" is a 23–24 span in month view. Test migration on a copy.
10. File-based task sources (Settings → Tasks → File-based tasks; switch with `Object.assign(p.settings,{…})` + `saveSettings()`, then look at `[data-task-row^="file:"]` in Gantt):
    - only "has date properties" + tag filter `#Project` → only Design.md (case-insensitive; `project` matches `project/alpha`);
    - only "contains tasks" → Design, Build, Inline tasks, Loose doc; `Inline tasks.md` has no date properties so its range comes from its tasks and the hover card says "Dates from tasks"; the 2026-10-19 daily note is excluded until "exclude daily notes" is turned off;
    - dragging a bar whose dates come from tasks writes `start`/`end` properties and shows "Saved the range to the note properties".
11. Display: today's date number has a red circle (month/week) or ring (year) regardless of the theme accent; in a ≈400px split pane the toolbar wraps to two rows with every button visible, lunar text hides, single-day month cards show only the title.
12. Language: with `settings.language = 'zh'` the view title is 甘特日历 and all UI is Chinese; lunar text is always Chinese; `showLunar` survives a plugin reload. Restore `language = 'system'` afterwards.

## 5. Dates, time slots and the task dialog

- **Start/due (🛫/📅) are a date range** (all-day bars, Gantt bars, month spans) without times. **The time of day comes from ⏳ + a leading Day Planner time prefix** (`14:00 - 16:00 task` / `14:00 task`), called a *time slot*, limited to one day. Both can coexist on one task (range bar + timeline block in week/day/sidebar; month/year only show the bar). This keeps every date readable by Tasks (it does not understand times after dates).
- Implementation: `expandTimeSlots` (`useViewTasks(..., timeAxis=true)`) turns ⏳ + prefix into `scheduledProxy.slot` proxies and lowers range bars to date precision; write-back goes through `resolveScheduledProxyUpdates` (only ⏳ and the prefix change, the range is untouched, end past midnight clamps to 24:00). Dragging a bar / all-day / list task onto the timeline = `asSlotTarget`, a new 1-hour slot. Drag ids and React keys of slots end in `#slot` (`ui/utils/taskId.ts`, `taskKey.ts`).
- **Legacy migration**: times on start/due/⏳ (`📅 2026-10-20 16:00`) on one day show as a slot (`legacy` proxy) and are migrated to ⏳ + prefix with date-only fields on any write-back (`updateTaskProperties` → `migrateLegacyTimes`); multi-day ones just lose the time.
- **Task dialog** (`src/ui/modals/TaskFormModal.tsx`), laid out like Obsidian's Properties panel:
  - **When** is a summary button (`.gc-task-kind__summary`, e.g. "Nov 17 → Nov 19 · 3 days", "Due Nov 20", "Fri, Nov 13 · 20:00–22:30 · 2.5 h") that opens a popover (`.gc-popover`) holding `WhenPicker` (`src/ui/components/WhenPicker.tsx`). Fields follow Tasks exactly: **Period** = 🛫 start + 📅 due (either may be empty), **Day** = ⏳ scheduled + the leading time prefix. Every section has a fixed height (quick entry, Period/Day toggle + Today/Tomorrow/This week chips, date cells, month grid, hint line, time row + hour strip), so nothing moves when switching.
    - Quick entry (`src/utils/parseWhenText.ts`, tests in `tests/parseWhenText.test.ts`): `tmr 14-16`, `fri → next wed`, `11/20 3d`, `明天 下午2点`, `周五 到 下周三`; the hint line previews the parse, Enter applies, unparseable input shakes.
    - Period: clicking Start/Due arms that cell; after a start pick Due is armed; clicking before the start swaps. A due-only task opens with Due armed and stays due-only.
    - Day: `TimeField` (text, shows the plugin's 12h/24h `timeFormat`, ↑/↓ ±15 min) replaces native `<input type=time>`; duration chips 30m/1h/2h/All day; `HourStrip` paints / moves / resizes a block (15-min snap). In Period mode the time section is dimmed; setting a time switches to Day. Switching kind and saving converts the task (summary shows "Converts on save").
    - Test hooks: `[data-cell=start|due|scheduled]`, `[data-date=YYYY-MM-DD]` on calendar days, `[data-kind=period|day]`, `[data-duration]`, `.gc-when-picker__quick`, `.gc-when-picker__strip` (dispatch `pointerdown`/`pointermove`/`pointerup` with ~30 ms between them).
  - Done / Cancelled / Created dates are always editable and linked to the status both ways (pick Done → done date = today; set a done date → status Done; clear it → back to Todo; same for Cancelled).
  - Nothing moves when switching: the dialog is top-anchored (`gc-modal__overlay--top`), tabs and priority segments have fixed widths (the priority name sits beside the segments), selected pills are not bold, scroll containers reserve the scrollbar gutter, and the popover grows but never shrinks while open. Check positions before/after a switch with `getBoundingClientRect()` — they must be identical.
  - Tags: hierarchical selector (top-level tags first, click to drill down, breadcrumb back; search shows all levels). A sub-tag implies its parents (`#task/project` is found by `#task`), so the selection keeps only the most specific tag: picking a child drops a selected ancestor, an ancestor of a selected tag shows dashed (`--implied`) and clicking it only expands it (`addTagMerged` / `mergeTagSet` in `tagSelectorModel.ts`).
- Check that Tasks still reads the dates: `obsidian eval code="app.plugins.plugins['obsidian-tasks-plugin'].cache.getTasks().filter(x=>x.path.includes('<file>')).map(x=>[x.startDate&&x.startDate.format('YYYY-MM-DD'),x.dueDate&&x.dueDate.format('YYYY-MM-DD')])"`.
- **"Edit task" command** (`gantt-calendar:edit-task`, `editorCallback`, always listed): on a task line it opens the edit dialog (a checkbox line without the global filter gets it added first); on an empty or plain-text/list line it opens the **create** dialog prefilled with the line's text and writes the new task onto that line (`createTaskAtLine`; if the line changed meanwhile it inserts below). Headings, quotes, code fences and tables are refused. Test: open the note → `ed.setCursor({line,ch})` → `app.commands.executeCommandById('gantt-calendar:edit-task')` (set `document.hasFocus=()=>true` first).
- The create dialog has a "create in" select (today's daily note / a file task covering that day / another note); non-daily targets go after the last task (incl. sub-lines) via `createTaskInFile`. Hover ghosts / click-to-create on empty timeline space are suppressed inside existing blocks (`clampForwardPointEnd` returns min); each column has its own `.gc-week-view__ghost`.

## 6. ICS subscriptions (Settings → ICS)

ICS events are **read-only and in memory only** (like Day Planner): `IcsService` fetches into `calendarStore.icsEvents`; day/week/month views and the sidebar timeline render them as `[data-ics-event]`; nothing is written to notes. Config: `settings.syncConfiguration.ics` (`subscriptions[]: {id,name,url,color,enabled}` + `syncInterval`).

Serve a local file — never put private (token-bearing) subscription URLs in the repo, docs or fixtures:

```bash
cd <tmp dir with t.ics: timed / all-day / RRULE events> && setsid nohup python3 -m http.server 8765 >/dev/null 2>&1 < /dev/null &
obsidian eval code="(async()=>{const p=app.plugins.plugins['gantt-calendar'];p.settings.syncConfiguration.ics={subscriptions:[{id:'t',name:'Test',url:'http://localhost:8765/t.ics',color:'#e5484d',enabled:true}],syncInterval:0};await p.saveSettings();await p.icsService.refresh();})()"
obsidian eval code="JSON.stringify([...document.querySelectorAll('[data-ics-event]')].map(e=>e.title))"
```

Acceptance: timed events on the week/day timeline and sidebar, all-day/multi-day as bars in the subscription colour, no checkbox/drag/resize/context menu; when a fetch fails (stop the server, `icsService.refresh()`) the last good events stay and a notice appears; `TZID` as IANA or Windows name (`China Standard Time`) converts correctly, unknown Windows names fall back to local time; in month view the location is hidden. **Clear the subscription afterwards** (`ics={subscriptions:[],syncInterval:0}` + `saveSettings()`): `data.json` would keep the URL.

## 7. Filter panel (toolbar Filter → File / Task)

The engine is chosen by the first meaningful line (blank and `#`/`//` comment lines skipped; in Datacore queries `#tag` lines are tags):

| Page | First line | Engine |
| --- | --- | --- |
| Task | `TASK …` | Dataview |
| Task | `@…` (e.g. `@task and $completed = false`) | Datacore |
| Task | anything else | Tasks syntax (own evaluator) |
| File | `LIST` / `TABLE` / `FROM` (uppercase) | Dataview (`FROM` alone runs as `LIST FROM`) |
| File | `@…` (e.g. `@page and path("Projects")`) | Datacore |
| File | anything else | Bases expressions (default); a selected `.base` file's filters are ANDed |

Results are matched to tasks by `path:line` (Dataview/Datacore lines are 0-based, plugin lines 1-based). Autocomplete pops up under the caret (↑/↓, Enter/Tab, Esc closes only the popup, Ctrl+Space forces it); an Examples list inserts samples; the status line shows the engine chip and "✓ N matching tasks/notes" or "✗ …".

```bash
# probe Dataview directly
obsidian eval code="(async()=>{const r=await app.plugins.plugins['dataview'].api.query('TASK FROM \"GC QA\" WHERE !completed');return JSON.stringify(r.value.values.map(t=>[t.path,t.line,t.text]))})()"
# type into the query box (controlled textarea → native setter + input event; set the caret for suggestions)
obsidian eval code="(async()=>{const t=[...document.querySelectorAll('[class*=filter-panel] textarea')].at(-1);t.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'due b');t.setSelectionRange(5,5);t.dispatchEvent(new Event('input',{bubbles:true}))})()"
```

Acceptance: only matching tasks show; `GROUP BY` works for `TASK`; syntax errors / non-TASK Dataview queries on the Task page report in the panel and do not filter; disabled Dataview/Datacore reports "not installed or not enabled"; the task view and the sidebar task list are separate filter scopes. **Click Reset afterwards** — filters persist in `data.json` (`settings.viewFilters`).

## 8. Known issues and gantt-calendar pitfalls

- **Startup scan race**: notes created/changed on disk while Obsidian was closed may be missed on the first scan (metadataCache not indexed yet) until they change again. After creating fixtures on disk call `taskCache.refreshFile(path)` for each file, or reload the plugin.
- **Duplicate tasks** (fixed 2026-11-12): a write-back's `refreshFile` used to run concurrently with the debounced `modify` pass for the same file; with a line inserted in between, both stored different `path:line` keys and the stale one stayed (the same task showed before and after an edit). File passes are now serialized per file in `MarkdownDataSource`, rename/delete in flight do not write back, and `TaskRepository.getAllTasks()` dedupes by `path:line` and logs a warning. Regression test: `tests/taskDedupe.test.ts`; live check: insert lines above a task while editing it through the plugin, then count `path:line` duplicates in `getAllTasks()` (must be 0).
- **Stuck invisible modal overlay** (fixed 2026-11-12): if the exit animation callback is missed, the transparent overlay blocks every click. `Modal.tsx` now sets `gc-modal__overlay--closing` (no pointer events) and removes itself on a timeout. After closing dialogs in tests, `document.querySelectorAll('.gc-modal__overlay').length` must be 0.
- **Link-only tasks**: `[title](zotero://…)` used to render as nothing (non-http schemes were dropped). `classifyMarkdownHref` (`src/utils/linkText.ts`) keeps the text: external schemes open through Obsidian/system, scheme-less targets (`[x](Note.md)`) are internal links, only `javascript:/data:/vbscript:/file:` are blocked. Both renderers (`DescriptionWithLinks.tsx`, `linkRenderer.ts`) use it.
- **Month view wheel**: the wheel switches months, but only after the month grid has scrolled to its top/bottom edge (rows grow with content and can overflow). Before 2026-11-12 every wheel tick switched the month, which silently moved the shared date (e.g. Week/Day then showed October).
- Task lines need the global filter `#task` anywhere on the line (start, after the time prefix, or end; `#task/xxx` counts, `#tasks` and `a#task` do not).
- Changing settings writes `.obsidian/plugins/gantt-calendar/data.json` in the test vault; no need to restore it, but never copy a test vault's data back to a real vault.
