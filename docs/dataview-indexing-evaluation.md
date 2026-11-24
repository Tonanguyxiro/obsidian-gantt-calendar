# Dataview Primary Indexing & Fallback Evaluation

## 1. Architecture Overview

`TaskStore` coordinates a two-tier indexing strategy behind the `IDataSource` interface (`src/data-layer/IDataSource.ts`), backed by `TaskRepository`:

1. **Primary source — `DataviewDataSource` (`src/data-layer/DataviewDataSource.ts`)**
   - Selected when `isDataviewIndexingAvailable(app)` is true: the `dataview` plugin is installed, enabled (`enabledPlugins.has('dataview')` when present), exposes `api.pages()`, and `index?.initialized !== false`.
   - Reads pre-indexed task items directly from memory via `api.pages().file.tasks` (with fallback iteration over `api.pages()` when mocked).
   - **Boundary conversion**: only primitive properties (`path`, `line`, `symbol`, `status`, `text`, `completed`) are extracted at the boundary. Private Dataview objects (`DataArray`, `Link`, Luxon `DateTime`, AST/page caches) are never stored in `GCTask` or `TaskRepository`.
   - Each item is reconstructed to its first markdown line (`${symbol} [${status}] ${firstLine}`) and parsed through `parseSingleTaskLine(...)` (`src/tasks/taskParser/main.ts`) so `globalTaskFilter`, `enabledFormats`, `plannerTime`, `datePrecision`, `repeat`, custom statuses, `cancelledDate`, `metadataFields`, and `tags` match `MarkdownDataSource` identically.
   - **Incremental updates**: subscribes to `app.metadataCache.on('dataview:metadata-change', ...)` (`update`, `delete`, `rename`), serialized per file (`runningRuns`/`queuedRuns`), with `fingerprintTask` diffing, line-drift re-pairing, and `fileSnapshots` self-healing reconciliation.
   - **Immediate write-back refresh**: `refreshFile(filePath)` reads and parses only that single modified file directly (`source: 'direct'`), ensuring `getAllTasks()` / `getTasksByDateRange()` reflect write-backs immediately without waiting for Dataview's background web-worker re-index. When `dataview:metadata-change` later arrives with matching fingerprints (or older `mtime`), it is safely ignored without duplicate events.

2. **Fallback source — `MarkdownDataSource` (`src/data-layer/MarkdownDataSource.ts`)**
   - Scans vault markdown files in batches of 50 using `metadataCache.getFileCache(file)?.listItems` and `vault.read(file)`, plus vault `modify`/`create`/`delete`/`rename` watchers.

## 2. Real-Vault Probe Findings (Obsidian 1.15.1, Dataview 0.5.68)

Probed directly in live Obsidian against `dev-example-vault` and `dev-real-vault` (and cross-checked with Dataview's `FileImporter` worker `parseLists` implementation):

| Check | `dev-example-vault` | `dev-real-vault` | Notes |
| --- | --- | --- | --- |
| Total markdown pages | 180 | 401 | — |
| Task-bearing pages | 94 | 108 | — |
| Total Dataview tasks | 480 | 952 | `missingInDvCount: 0` vs `metadataCache.listItems` |
| `trimmedFirstLine !== rawBody` diffs | 0 / 480 | 0 / 952 | Dataview does **not** strip metadata from `t.text` |
| Multiline continuation tasks (`\n` in `t.text`) | 2 | 42 | Continuation lines appear after `\n` in `t.text` |
| Dataview `[key:: value]` tasks | 35 | 0 | `[owner:: ...]`, `[due:: ...]` preserved verbatim in `t.text` |
| `🔁` repeat tasks | 6 | 0 | Preserved verbatim in `t.text` |
| `❌` cancelled date tasks | 0 | 8 | Preserved verbatim in `t.text` |

Key empirical findings:
- **No metadata stripping in `dvTask.text`**: Dataview constructs `text` via `LIST_ITEM_REGEX = /^[\s>]*(\d+\.|\d+\)|\*|-|\+)\s*(\[.{0,1}\])?\s*(.*)$/mu`. All Tasks emojis (`➕`, `🛫`, `⏳`, `📅`, `✅`, `❌`, `🔁`), priority emojis (`🔺`, `⏫`, `🔼`, `🔽`, `⏬`), Day Planner prefixes (`08:00 - 11:00`, `14:00`), tags, wikilinks, Dataview inline fields (`[key:: value]`), and `%%[guid:: ...]%%` comments remain intact in `dvTask.text`.
- **Multiline tasks**: When a task item has indented continuation lines (`lineCount > 1`), Dataview joins them with `\n` into `dvTask.text`. Since `MarkdownDataSource` parses only the task header line (`lines[item.position.start.line]`), `DataviewDataSource` extracts `rawText.split(/\r?\n/)[0]` before calling `parseSingleTaskLine`.
- **Tag extraction difference**: Dataview's `t.tags` treats wikilink headings (e.g. `[[Alpha#目标]]` in `GC QA/Inline tasks.md`) as tags (`#目标`), whereas `gantt-calendar`'s `extractTags` excludes wikilinks. Re-parsing the reconstructed line via `parseSingleTaskLine` preserves exact tag semantics.
- **Line numbering & fileName**: Dataview `line` is 0-based; `GCTask.lineNumber` is 1-based (`line + 1`), and `GCTask.fileName` is `TFile.basename` (without `.md`).

## 3. Parity & Performance Comparison

Measured in live Obsidian with `globalTaskFilter = "#task"` and `enabledTaskFormats = ["tasks"]`:

### Parity
- `dev-example-vault`: Dataview returned 480 raw tasks → **420** passing `#task` filter; `MarkdownDataSource` returned **420** (`onlyGc: []`, `onlyDv: []`).
- `dev-real-vault`: Dataview returned 952 raw tasks → **261** passing `#task` filter; `MarkdownDataSource` returned **261** (`onlyGc: []`, `onlyDv: []`).

### Performance
- `dev-example-vault` (180 files / 480 tasks):
  - `Dataview` (`api.pages().file.tasks`): **6.1–7.2 ms** in-memory, **0** `vault.read()` calls.
- `dev-real-vault` (401 files / 247 files with `listItems` / 108 task-bearing files / 952 tasks):
  - `Dataview` (`api.pages().file.tasks`): **14.1–17.8 ms** (`api.pages().where(p => p.file?.tasks?.length > 0)`: **13.5 ms**), **0** `vault.read()` calls.
  - `MarkdownDataSource` file I/O floor (`vault.read()` across the 247 list-bearing files in batches of 50): **52.3 ms** for disk reads alone (excluding line splitting, regex parsing, and batch yields).

Combined with `TaskRepository` secondary date-bucket indexing (`dateBuckets` + `longSpanIds` + `recurringTaskIds`) and `TaskStore.getTasksByDateRange`, calendar views avoid both full-vault disk scans on startup and full-cache linear scans on view updates.

## 4. Fallback Behavior

`TaskStore` handles every non-ready or error condition automatically:

1. **Dataview missing or disabled**: `isDataviewIndexingAvailable(app)` returns `false`; `TaskStore` uses `MarkdownDataSource` immediately.
2. **Dataview installed & enabled, index not ready (`index.initialized === false`)**: `TaskStore` initializes `MarkdownDataSource` immediately so `whenReady()` resolves without blocking UI skeleton mount, and registers a one-shot `'dataview:index-ready'` listener on `app.metadataCache`. Once Dataview finishes indexing, `TaskStore` swaps cleanly to `DataviewDataSource` and refreshes listeners.
3. **Initialization or runtime error**: If `DataviewDataSource.initialize()` throws or `dataview:metadata-change` hits a fatal API failure, `TaskStore` destroys the Dataview source, clears/re-registers `MarkdownDataSource`, re-scans from disk, and notifies views.
