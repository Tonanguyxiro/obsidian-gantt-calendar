# CLAUDE.md

本文件为 Claude Code 在此代码库中工作时提供指导。

## 构建

```bash
npm run dev          # esbuild watch 模式
npm run build        # tsc 类型检查 + esbuild 生产打包 + 同步到 example vault
```

构建产物为 `main.js`（单文件 CJS bundle，外部依赖 `obsidian`、`electron`）。

**测试**：`src/data-layer/__tests__/` 下有少量 Jest 测试，直接 `npx jest` 运行（270 用例）。

## 架构

### UI 层（React，自阶段0-5重构完成）

- `main.ts` 注册 2 个 Obsidian ItemView：`GCMainView`（主日历视图）和 `GCSidebarView`（右侧栏），均为 React 挂载壳
- `src/ui/App.tsx` 挂载 `ModalProvider` + `TooltipProvider` 包裹 6 个视图：`YearView`、`MonthView`、`WeekView`、`DayView`、`TaskView`、`GanttView`
- `src/ui/sidebar/` — `SidebarApp`（Tab 壳）+ `TaskListPanel` + `DailyTimelinePanel`
- `src/ui/components/` — 基础组件（Icon/DropdownMenu/Modal/TooltipProvider/ContextMenu/TaskCard/Toolbar）
- `src/ui/modals/` — 模态框：`TaskFormModal`（创建/编辑双模式）、`ConfirmDialog`、`SyncResultDialog`；`modalHost.ts` 为插件级全局 React 宿主，提供 `openReactModal()` 命令式桥接，供设置面板等非 React 环境打开 React 模态框
- 甘特图与设置面板不 React 化（决策保留）：SVG 引擎 `src/gantt/wrappers/svgGanttRenderer.ts`，设置面板 `src/settings/` 为命令式 Builder 模式
- 数据状态经 `src/ui/store/calendarStore.ts`（zustand）与插件上下文 `src/ui/pluginContext.tsx`

### 数据层（分层架构）

```
TaskStore（门面，供视图使用）
  ├── EventBus（发布-订阅事件系统）
  ├── TaskRepository（仓库模式，内存 Map 缓存 + 文件索引）
  │   └── MarkdownDataSource（扫描 vault 文件，50 个一批，metadataCache 解析）
  └── SyncManager（可选，通过 SyncManagerBridge 连接）
```

- `TaskStore.getAllTasks()` 返回缓存结果，缓存通过防抖（75ms）失效
- `MarkdownDataSource` 文件修改事件防抖 50ms，处理 create/modify/delete/rename
- 任务解析采用四步流水线：`step1` 正则匹配 → `step2` 全局筛选符 → `step3` 格式检测 → `step4` 属性解析
- 变更检测采用指纹字段级 diff：L3 缓存（`MarkdownFileCache.taskFingerprints`）逐任务比对轻量指纹，未变化的任务不发事件（避免大文件编辑的事件风暴）

**已知优化空间——任务身份跟行号走**：任务 ID 均为 `路径:行号` 制（数据层 `filePath:lineNumber`，甘特层 `文件名-行号-路径哈希`），内容指纹只用于变更检测、不参与身份判定。插入/删除行会导致下方任务 ID 集体漂移（diff 走"错位继承"保证内容正确，但甘特增量更新可能误判为大量新增+删除而升级全量重绘）。如后续遇到"插入行导致甘特图闪重绘/身份重排"类问题，优化方向是 ID 掺入内容短哈希（`文件名-行号-内容哈希`），diff 改为内容哈希匹配优先、行号兜底；涉及数据层 diff、甘特 diff、删除占位三处配套改造。当前为有意保持的现状（2026-08 决策），非缺陷。

### 同步系统

支持飞书双向任务同步，CalDAV 基础设施已搭建：
- `src/data-layer/feishu-sync/FeishuTaskSync.ts` — 自包含双向同步引擎
- `src/data-layer/sources/api/providers/feishu/` — 完整飞书 API 客户端（OAuth、Task、User API）
- `src/data-layer/sync/SyncManager.ts` — 多源同步编排（拉取→匹配→冲突检测→解决→本地应用→推送 共 6 阶段）
- `src/data-layer/sources/caldav/` — Google/Apple/Outlook CalDAV 提供者基础设施
- `src/data-layer/ics/` — ICS 订阅（参考 Day Planner）：`IcsService` 拉取并解析（`icsParser`），事件只存内存（`calendarStore.icsEvents`），经 `useIcsLayer` 转为只读占位任务（`GCTask.icsEvent`，`IcsEventCard` 渲染）合入日/周/月视图；不写 markdown，拉取失败沿用上次成功内容
- 同步配置位于 `plugin.syncConfiguration`，飞书状态持久化于 `.feishu-sync-state.json`；ICS 配置在 `syncConfiguration.ics`

### 甘特图

实际实现是自定义 SVG 渲染引擎 `src/gantt/wrappers/svgGanttRenderer.ts`，支持拖动整体/端点、导航按钮、增量刷新。

### 设置系统

`SettingTab.ts` 使用 Builder 模式，各 builder 负责一个设置区域，未 React 化。

## 关键约定

**ALWAYS 遵守：**
- **DOM 类名**：在 `src/utils/bem.ts` 中定义 BEM 块常量并引用，禁止硬编码字符串
- **正则表达式**：在 `src/utils/RegularExpressions.ts` 中定义并引用，禁止内联正则
- **任务悬浮窗**：复用 `src/utils/tooltipManager.ts`，禁止自行实现
- **任务条目更新**：使用 `updateTaskProperties()` 函数，禁止直接操作 markdown 文本
- **修改 DOM/样式前**：先检查并移除已废弃的旧类名
- **React 代码**：UI 一律走声明式 React，禁止 createEl/createDiv/addEventListener 手写 DOM（基础组件/宿主/Icon 封装除外）

**代码模式：**
- 各视图在 `src/components/TaskCard/presets/` 下有对应配置 preset
- 右键菜单命令在 `src/contextMenu/commands/`，由 React 组件直接导入使用（`contextMenuIndex.ts` 已移除）
- 视图过滤状态按键名 `${viewName}SelectedStatuses`/`${viewName}SelectedTags` 持久化
- 模态框命令式入口：`openCreateTaskModal`/`openEditTaskModal`/`showConfirmDialog`/`showSyncResultModal`（`src/ui/modals/`，经 `modalHost` 桥接）

## 注意事项

- **Windows 环境**：Git Bash 中 `2>nul` 会创建实体文件而非重定向，始终使用 `2>/dev/null` 或专用工具（Glob/Grep）
- **TypeScript**：`strictNullChecks: true`、`noImplicitAny: true`、`importHelpers: true`、target ES6
- **ESLint**：`no-unused-vars` 为 error（允许 `args` 前缀），`ban-ts-comment` 关闭；`prefer-active-doc` 在 portal/全局事件场景为 warning 可接受

## Git 规则

- **NEVER 自动 commit 或 push** — 仅当用户明确要求时执行
- 允许 `npm run build`、`git status`、`git diff` 等验证性操作
- `npm run version` 用于 bump manifest.json + versions.json