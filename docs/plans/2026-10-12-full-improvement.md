# obsidian-gantt-calendar 全面改进实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 执行四维度审查的全部改进：性能隐患 1/2/4/5、视觉短板增强、UX 删除确认+撤销、同步架构收敛、TS 升级，以及交叉对比后的其余全部建议（快捷键、月格快速创建、NL 轻解析、边缘滚动、focus trap、CI、首次引导）。

**Architecture:** 5 个阶段、17 个有效任务串行执行（T12 已取消）；每任务 TDD（先测后码）+ 独立 commit（**用户已授权每任务一 commit**）。基础设施（TS5）先行，安全网（确认/撤销）次之，渲染性能、视觉、交互随后，同步收敛与交付收尾。全程遵守 CLAUDE.md：BEM 常量（bem.ts）、正则集中（RegularExpressions.ts）、任务更新走 updateTaskProperties、tooltip 复用 tooltipManager、React 声明式（Icon/命令式桥接除外）。

**Tech Stack:** TS + React 19 + zustand + motion；Jest/ts-jest/jsdom；esbuild。新增依赖：`react-virtuoso`（运行时，虚拟化）、`typescript ^5.9` + `@types/node ^20`（devDep 升级）。其余零新依赖。

**通用验证（每任务必做）：** `npx jest`（相关用例）→ `npm run build`（tsc+esbuild+CSS 合并）→ `npx eslint <变更文件>`；i18n 新键 en.json+zh.json 同步；commit 信息格式仿照 git log 现有风格（类型前缀+根因+TDD 说明）。

---

## Phase A — 基础设施与安全网（T1-T5）

### T1 TypeScript 5.x + 全量 strict + 清理 deprecated 转发层

**Files:** `package.json`（typescript ^5.9、@types/node ^20）、`tsconfig.json`、`tsconfig.test.json`、删除 `src/tasks/taskParser.ts`（296 行 deprecated 转发层，先 grep 确认无 import 后删）。

**Design:** tsconfig compilerOptions：`strict: true` + `strictPropertyInitialization: false`（存量类字段大量在方法内赋值，开启成本不成比例）；`moduleResolution: "bundler"`（替换过时的 "node"，配 esbuild 正确）；移除陈旧 exclude `ref`。@types/node 16→20 与 Obsidian Electron 对齐。
**Steps:** ① 升级依赖跑 `npx tsc -noEmit` 枚举错误 → ② 逐类修复（预期少量：泛型推导、`useRef<T>()` 初始值、lib 差异）→ ③ grep `from './taskParser'|from '../taskParser'` 确认转发层无人引用（step 测试引的是 `taskParser/` 目录）→ 删除 → ④ 全量 jest + build + eslint。
**Test:** 既有 390 用例全绿即回归通过；无新测试（纯基建）。若 strict 暴露真实类型缺陷（如可能的 null 未处理），修复并在 commit message 记录。

### T2 删除确认 + deleteTask 加固

**Files:** 改 `src/contextMenu/commands/deleteTask.ts`；新 `tests/deleteTask.test.ts`。

**Design:** 现状：直接 splice 删行，无确认、无文件锁、无漂移校验（与 updateTaskProperties 不对称）。改造：
1. 删除前 `showConfirmDialog(app, i18n.t('contextMenu.commands.deleteConfirmTitle'), i18n.t('contextMenu.commands.deleteConfirmMessage', {description}), {isDestructive: true, confirmText: ...})`——ConfirmDialog/modalHost 基建现成（`src/ui/modals/ConfirmDialog.tsx:60`）。
2. 加固：删行前在 `withFileLock(task.filePath)` 内重读文件，行号漂移时 `lines.findIndex(l => lineMatchesTask(l, task, globalFilter))` 重定位（复用 `src/tasks/taskUpdater.ts:91` 的既有函数，需 export），找不到则 Notice 报错中止。
**Test:** jsdom + obsidian mock：① 未确认（onResult false）→ vault.modify 不被调用；② 确认 → 目标行被删；③ 行号漂移场景（预插一行）→ 仍删对任务行。showConfirmDialog 经 jest.mock 替换为直接 resolve。
**Commit:** `feat: 删除任务增加确认弹窗与行号漂移防护——deleteTask 接入 showConfirmDialog(isDestructive)，删行纳入 withFileLock 并复用 lineMatchesTask 重定位`

### T3 首扫批量事件（性能隐患 5）

**Files:** 改 `src/data-layer/TaskRepository.ts`（handleSourceChanges :162-252）、`src/data-layer/types.ts`（事件联合类型）、`src/data-layer/MarkdownDataSource.ts`（notifyInitialTasks :157-168）、`src/TaskStore.ts`（订阅 :97-121）；测试 `src/data-layer/__tests__/TaskRepository.test.ts` 扩展 + `tests/eventStorm.test.ts` 回归。

**Design:** 现状：notifyInitialTasks 把全部任务作为一次性 created 批交给 handleSourceChanges，但内部逐任务 `eventBus.emit('task:created')` → TaskStore 每事件 invalidateCache+防抖 reset（2410 任务≈2410 次定时器 churn）。改造：
1. IDataSource 变更回调签名加 `opts?: { initial?: boolean }`；MarkdownDataSource.notifyInitialTasks 传 `initial: true`。
2. handleSourceChanges：`initial` 时逐任务维护缓存（taskCache.set/fileIndex）但**不发**逐任务事件，末尾发单个 `tasks:loaded`（payload `{ tasks }`，加入 types.ts 事件联合）。
3. TaskStore 订阅 `tasks:loaded`：一次 invalidateCache + notifyListenersDebounced()。
4. 非初始变更（编辑/单文件刷新）路径不变。
**Test:** ① initial 批量：emit('task:created') 0 次、emit('tasks:loaded') 1 次；② 缓存仍完整（getAllTasks 数量正确）；③ TaskStore 收到 tasks:loaded 后 updateListeners 恰好触发一次（防抖冲刷后）。
**Commit:** `perf: P2 首扫逐任务 emit 改单批 tasks:loaded——2410 任务从 2410 次 invalidate+防抖reset 降为 1 次，消除首扫定时器 churn`

### T4 状态栏统计防抖 + 值比对（性能隐患 4）

**Files:** 改 `main.ts`（renderStatusBar :274-285、onUpdate 订阅 :269-271）；测试 `tests/statusBar.test.ts`。

**Design:** ① 计数防抖 300ms（独立于 TaskStore 的 75ms，状态栏是低频消费方）；② 缓存上次字符串，相同则跳过 setText（DOM 零触碰）；③ getAllTasks 结果引用没变时直接复用上次计数。
**Test:** fake timers：① 100ms 内 10 次 onUpdate → 只 1 次重算；② 任务数未变 → setText 不调用（spy）；③ 任务增减 → 文案更新。
**Commit:** `perf: 状态栏统计 300ms 防抖+值不变跳过 setText——原每次 onUpdate 全量 filter+DOM 写`

### T5 任务操作撤销服务（P0-1 后半）

**Files:** 新 `src/tasks/taskUndo.ts`、i18n 键；改 `src/contextMenu/commands/`（postponeTask/setPriority/setTaskStatus/cancelTask/restoreTask/deleteTask 接入）；测试 `tests/taskUndo.test.ts`。

**Design:** 单级撤销（仅最近一次操作），两层：
1. **属性类撤销**：`updateWithUndo(app, plugin, task, updates, label)` —— 先 `captureBefore(task, updates)`（从 task 快照取 updates 涉及字段的现值），调 updateTaskProperties，成功后 `offerUndo`：`new Notice(label, 8000)` + messageEl.createEl('button'){撤销} → 点击以 before 值再调 updateTaskProperties（复用其文件锁+漂移校验，天然安全）。先例：feishuCommands.ts:109-141 的 Notice 按钮。
2. **删除撤销**：deleteTask 确认通过后记录 `{filePath, lineNumber, line}`，Notice 撤销 = 在文件锁内把行插回原位置（越界钳制到末尾）。
覆盖入口：右键菜单 6 命令 + 甘特/月/周拖拽写回点（拖拽处已有 updateTaskProperties 调用的，替换为 updateWithUndo）。
**Test:** ① postpone 后点撤销 → dueDate 还原（mock vault 断言两次 modify 的行内容）；② 删除撤销 → 行恢复原位；③ 连续两次操作只保最新撤销项。
**Commit:** `feat: 任务操作撤销——右键菜单/拖拽改期/删除统一 offerUndo 单级撤销（Notice 按钮），before 快照经 updateTaskProperties 回滚`

---

## Phase B — 渲染性能（T6-T7）

### T6 settingsVersion 退场：设置进 store（性能隐患 1）

**Files:** 改 `src/ui/store/calendarStore.ts`（+settings state/setSettings）、`main.ts`（loadSettings/saveSettings 后 setSettings）、`src/managers/SettingsManager.ts`、`src/GCMainView.ts:97`/`src/GCSidebarView.ts:96`（refreshSettings 改为 setSettings 快照）、`src/ui/App.tsx:68-89`（key 去 settingsVersion）、`src/ui/components/Toolbar.tsx:51,197-201`、`src/ui/components/MobileNavDock.tsx:38`、各视图 `plugin.settings.*` 读点改 store selector；测试 `tests/settingsNoRemount.test.ts`（jsdom）。

**Design:** 根因：plugin.settings 是可变对象经 Context 提供，React 无感知，settingsVersion 自增+key 重挂是补偿机制。根治：
1. calendarStore 增 `settings: PluginSettings`（不可变快照）+ `setSettings(s)`（替换引用）。
2. 写路径统一：任何设置变更 → 构造新对象 `plugin.settings = {...plugin.settings, ...patch}` → `saveSettings()`（其内含 taskCache.updateSettings 重扫副作用，保留）→ `setSettings({...plugin.settings})`。Toolbar.updateTaskViewSettings、SettingsManager、BaseBuilder.saveAndRefreshViews 全部走此模式；ViewManager.refreshAllViews 改调各视图 `syncSettings()`（新方法=setSettings 快照，不再 bump）。
3. 读路径：视图把 `const plugin = usePlugin(); plugin.settings.x` 改为字段级 selector `useCalendarStore(s => s.settings.x)`（useMemo 依赖随之更新，引用稳定）。bumpSettings/settingsVersion 字段删除。
4. App.tsx：AnimatePresence `key={viewType}`；甘特分支 key 去版本号。
**Test:** jsdom 渲染 App（app.skeleton.test.ts 模式）：① setSettings 改 monthViewTaskLimit → MonthView 不重挂（mount 计数 spy 不变）且 useMemo 重算生效（DOM 反映新上限）；② 切换 viewType 仍正常换视图。
**Commit:** `perf: 根治设置变更整树重挂——settings 镜像进 calendarStore（不可变快照+字段级selector），App key 去 settingsVersion，bumpSettings 删除；TDD：settingsNoRemount 先证旧路径重挂`
**风险控制:** 视图 settings 读点约 30-50 处，逐文件 grep `plugin.settings` 机械替换；若个别视图 useMemo 依赖数组漏改，settingsNoRemount 类单测+人工冒烟兜底。

### T7 列表虚拟化 + 日期范围索引（性能隐患 2 + P2-7）

**Files:** `package.json`（+react-virtuoso ^4）、`src/ui/views/TaskView.tsx`、`src/ui/sidebar/TaskListPanel.tsx`、`src/styles/views/base.css`（.gc-view--task 自滚动）、`src/styles/components/sidebar.css`、`src/TaskStore.ts`（getTasksByDateRange + 日期索引）、改 Month/Week/Day 视图取数；测试 `tests/taskViewVirtual.test.ts`、`src/data-layer/__tests__/`（索引单测）。

**Design（用户已选 react-virtuoso）:**
1. **TaskView**：`.gc-view--task` 改 `height:100%; overflow:hidden`，Virtuoso 作为唯一滚动容器（flex:1），行渲染保留序号+TaskCard；`components.Footer` 空。App.tsx 的 waterfall overflow 对 task 分支豁免（isWaterfall 去掉 'task'）。
2. **TaskListPanel**：`.gc-sidebar__content` 头部区保留，列表区换 Virtuoso（自身滚动），compact 配置不变。
3. **日期索引**：TaskStore 缓存重建时懒构建 `Map<dateStr, Set<taskId>>`（任务的全部相关日期字段各入一桶，含 due/start/scheduled/completion），`getTasksByDateRange(start,end)` 并集去重返回。Month/Week/Day 视图的日期过滤改走此 API（月视图 42 天、周日 7 天从全量 O(N) 扫描降为按桶取）。
**Test:** ① jsdom 渲染 TaskView 3000 条 → `.gc-task-view__row` DOM 数 < 100（jsdom 需 stub IntersectionObserver/ResizeObserver，加进 tests/__mocks__/setup）；② getTasksByDateRange 与全量过滤结果一致性（随机任务集对拍）；③ 空/单条列表正常渲染。
**Commit:** `perf: TaskView/侧栏任务列表 react-virtuoso 虚拟化 + TaskStore 日期桶索引 getTasksByDateRange——3000 任务 DOM 行数从 3000 降 <100，视图日期过滤从全量扫描降为按桶取`

---

## Phase C — 视觉增强（T8-T10）

### T8 CSS token 落地清扫

**Files:** `src/styles/`（tokens.css + components/*.css + views/*.css + theme.css + settings.css）。

**Design:** 机械替换 + 少量新增 token，映射规则：
- **间距**：`--gc-space-1..6`（4/8/12/16/24/32）已定义零使用 → padding/gap/margin 值命中刻度即换 token；高频非刻度值（6px/20px 等，grep 计数 ≥5 次）新增 `--gc-space-*` 档位；布局几何值（1px hairline、SPAN_ROW_PX 类、时间轴像素）**不动**。
- **圆角**：6/8/10/14/999 → 既有 5 档 token；4px 高频则新增 `--gc-radius-xs`。
- **字号**：硬编码 88 处按语义归入 `--gc-font-xxs~lg`（clamp 响应式，随根字号缩放——替换后自定义字号用户视觉会变，属预期改进）。
- **颜色**：toolbar.css 27 处阴影组 → `--gc-elev-1..4`；rgba 覆盖层 → `color-mix(in srgb, var(--gc-*) N%, transparent)`；5 处 `#888888` 冗余回退删除；`--gc-color-orange` 双回退打架（toolbar 147-148 #ff6b4a vs tokens #f97316）统一删回退；task-card.css 状态色组（410-442）color-mix 字面量换 `var(--gc-color-*)`；theme.css:177-189 "今天"红 → `color-mix(var(--gc-danger) 10%/8%, transparent)`；heatmap 仅保留调色板 token 引用。
- **文档对齐**：month-view.css 头注释与实际 hairline 网格一致化。
**Test:** 无 CSS 测试基建；验证 = build 成功 + 目测 example vault（构建同步产物）+ commit 内附替换统计（grep 前后计数）。
**Commit:** `style: 设计 token 落地清扫——间距/圆角/字号/阴影/颜色全量替换 var(--gc-*)，硬编码色 169→<20（仅保留 heatmap 数据驱动值），字号接入 clamp 响应式`

### T9 优先级图标化（emoji → Lucide）

**Files:** 新 `src/utils/priorityIcons.ts`（单一映射源）、改 `src/ui/components/TaskCard.tsx:41-55`、`src/components/tooltip/tooltipSections.ts:25-31`、`src/ui/modals/TaskFormModal.tsx:50-58`、`src/styles/components/task-card.css`（图标尺寸/色阶）。

**Design:** 三处重复 PRIORITY_ICONS 收敛为一个模块：`highest:'chevrons-up' | high:'arrow-up' | medium:'flag' | low:'arrow-down' | lowest:'chevrons-down' | normal:'circle-dashed'`（lucide 名，经 Icon 组件 setIcon 渲染）。颜色阶：task-card.css 按 priority-* modifier 用 `--gc-color-red/orange/yellow/green/cyan` 区分。tooltip（HTML 字符串管线，无法用 setIcon）改为纯文字 label + valueClass 着色（去 emoji）。**仅渲染层替换，taskParser 的 emoji 识别原样保留**（Tasks 格式兼容不动）。TaskCard 本地 PRIORITY_CLASSES 换用 bem.ts 已有 `PriorityClasses`（消除双定义）。
**Test:** 单测：priorityIcons 映射完整性（6 键、值均为合法 lucide 名单）；TaskCard 渲染冒烟（jsdom 断言 .task-card__priority-badge 内无 emoji 字符、有 svg）。
**Commit:** `refactor: 优先级展示 emoji→Lucide 图标单一映射源——TaskCard/Tooltip/TaskFormModal 三处重复定义收敛 priorityIcons.ts，色阶走语义 token，文本解析兼容不变`

### T10 Modal focus trap

**Files:** 改 `src/ui/components/Modal.tsx`（现有 Esc/焦点归还 :42-56 基础上）、`tests/modalFocusTrap.test.ts`。

**Design:** panel keydown 捕获 Tab：查询 panel 内可聚焦元素（`button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])`，过滤 offsetParent null），Shift+Tab 于首元素 → 聚焦末元素；Tab 于末元素 → 聚焦首元素。弹窗打开时默认焦点已是 panel（tabIndex=-1）。
**Test:** jsdom 渲染 Modal（createRoot，dayViewNarrowLayout 模式）：① 末按钮 Tab → 首按钮 focus；② 首按钮 Shift+Tab → 末按钮 focus；③ 单可聚焦元素时 Tab 不逃逸。
**Commit:** `a11y: Modal 焦点陷阱——Tab/Shift+Tab 循环约束在面板内，补全键盘可达性`

---

## Phase D — 交互增强（T11-T14）

### T11 快捷键体系（P0-2）

**Files:** 改 `src/commands/common.ts`（扩至 11 命令）、`src/ui/App.tsx`（容器 onKeyDown）、新 `src/ui/utils/viewShortcuts.ts`（键分发纯函数）、calendarStore（navigatePeriod action）、i18n。

**Design:** 双层：
1. **命令层**（addCommand，**不设默认 hotkeys**——官方建议避免全局冲突，用户可在快捷键设置自绑）：视图切换 ×6（日/周/月/年/任务/甘特）、回到今天、上一/下一周期、新建任务、打开侧边栏（已有）。命令定位活动 GCMainView（ViewManager）调其公共方法。
2. **容器层**（App 根 div onKeyDown，日历视图激活且无模态时）：`1-6` 切视图、`T` 今天、`←/→` 周期导航、`N` 新建（openCreateTaskModal targetDate=currentDate）。输入框聚焦时忽略（e.target tagName 判断）。navigatePeriod：按 viewType 偏移 currentDate（day±1/week±7/month±1/year±1），纯函数放 viewShortcuts.ts 便于单测。
**Test:** viewShortcuts 纯函数单测（键→动作映射、导航偏移计算、输入框目标豁免）；jsdom 集成：dispatchEvent KeyboardEvent('1') → store viewType 变化。
**Commit:** `feat: 快捷键体系——11 命令注册（无默认全局热键防冲突）+ 视图容器键 1-6/T/←→/N，navigatePeriod 按视图粒度导航`

### T12 月格双击快速创建（P1-3）——已取消，不实施

**Files:** 改 `src/ui/views/MonthView.tsx:294-321`（cell 加 onDoubleClick）、i18n。

**Design:** 空白格双击（`e.detail===2` 且 target 非 .gc-task-card）→ `openCreateTaskModal({app, plugin, targetDate: day.date, onSuccess: refreshTasks})`（签名现成支持预填，TaskFormModal.tsx:471-493）。单击跳日视图行为保留（双击会先触发一次单击——可接受：先跳 day 视图，双击第二次点击时已在 day 视图？**不行**——单击立即 setCurrentDate+setViewType('day')，双击第二击落在 day 视图上，弹窗不会开。改法：单击延迟 250ms 执行跳转，期间收到第二击则取消跳转改开弹窗（setDoubleClickTimer 模式）；或单击只选中高亮不跳转？**保守方案**：单击仍即时跳转，双击改为在"日期数字徽标"上加独立 onDoubleClick（数字徽标是原子元素，双击它不会先触发格子单击跳转——需冒泡阻止）。执行时以徽标方案先行，若冒泡时序不可行退回 250ms 延迟单击方案，两案都写进测试。
**Test:** jsdom：双击数字徽标 → openCreateTaskModal 被调（jest.mock spy）且 targetDate 正确；单击卡片/格不触发。
**Commit:** `feat: 月视图日期徽标双击快速创建任务——openCreateTaskModal 预填 targetDate，单击跳日视图行为不变`

### T13 自然语言日期轻解析（P1-4）

**Files:** 新 `src/tasks/naturalLanguageDates.ts`（纯解析）、`src/utils/RegularExpressions.ts`（新增 NL_DATE/NL_TIME 正则，遵守正则集中约定）、改 `src/ui/modals/TaskFormModal.tsx`（描述框 onChange 防抖 200ms 解析 + 提示 chip）、`src/ui/components/DateTimePicker.tsx`（parseDateText 迁入 naturalLanguageDates 复用）、i18n、样式（task form 区块既有类）。

**Design:** 词法（中文优先，英文 today/tomorrow 兜底）：今天/明天/后天/大后天、周X/本周X/下周X/下下周X、N天后、M月D日、M-D、YYYY-M-D、月底；时间：HH:mm、上午/下午/晚上+H[点[半|N分]]（下午3点→15:00）。解析描述**尾部**第一个日期词（含可选时间），返回 `{date, hasTime, matchedText}`。行为：仅**创建模式**且用户未手填日期字段时自动回填 dueDate（含时间则带时刻），chip 显示"已识别：明天 15:00 ✕"（✕ 清除回填）；不修改描述原文。Edit 模式只展示 chip 不回填。
**Test:** 解析器单测 30+ 用例（zh/en、边界：跨年 12-30、下周六 vs 本周六、非法日期 2-30 拒绝）；TaskFormModal 集成：输入"明天下午3点开会" → dueDate 回填明日 15:00，chip 出现，✕ 后清空。
**Commit:** `feat: 任务描述自然语言日期轻解析——尾部日期词识别自动回填 dueDate（创建模式+字段未动过才生效），不篡改原文，正则集中 RegularExpressions.ts`

### T14 拖拽边缘自动滚动（P1-5）

**Files:** 新 `src/ui/utils/autoScroll.ts`（attachEdgeAutoScroll(container): cleanup，rAF 循环 + 边缘 40px 区检测 + 速度渐变）、改 `src/ui/views/week/WeekTimelineGrid.tsx`（handleDragOver :754 接入，dragleave/drop 清理）、`src/ui/views/week/useBlockResize.ts`（pointermove 路径接入，滚动容器 columnEl.closest('.gc-week-view__tasks-grid')）。

**Design:** 指针 Y 距容器顶/底 <40px → 按 (1 - dist/40) 比例速度 scrollBy（4~16px/帧）；进入中立区停止；统一 cleanup 防 rAF 泄漏。HTML5 DnD 与 pointer 路径共用同一 helper。
**Test:** 纯函数单测：边缘检测区间与速度插值；jsdom + fake rAF：指针贴底 10 帧 → scrollTop 递增，指针居中 → 不滚，cleanup 后 rAF 停。
**Commit:** `feat: 周/日画布拖拽与 resize 边缘自动滚动——40px 感应区线性变速 rAF 循环，DnD/pointer 双路径共用 attachEdgeAutoScroll`

---

## Phase E — 架构治理与交付（T15-T18）

### T15 同步系统特征测试 + 口径 bug 修复

**Files:** 新 `tests/syncCharacterization.test.ts`（老引擎行为锁定：GUID 匹配、标题相似度 0.6 阈值、push-create/pull-update/conflict 分类、状态文件写回格式）、`src/data-layer/__tests__/taskMatcher.test.ts`、`conflictResolver.test.ts`、`versionTracker.test.ts`、`syncManager.calculateChanges.test.ts`、`syncFactory.test.ts`；改 `src/data-layer/sync/syncFactory.ts:80-86`（飞书注册条件 bug：查 appId/appSecret 而 OAuth 写的是 clientId/appId 双写，口径统一为两者皆可）、`src/data-layer/feishu-sync/syncState.ts:66-74`（save 静默吞错 → logger.warn）。

**Design:** 老引擎 FeishuTaskSync 构造仅需 mock（app/provider/state/options），其 private 匹配/检测逻辑经 sync()/testSync() 黑盒驱动断言。新框架纯逻辑单测直接实例化。这些测试是 T16 迁移的安全网——迁移后期望改写为新引擎接口而断言不变。
**Test:** 即上述文件本身。目标覆盖：matcher 三策略、resolver 四策略+字段合并、calculateChanges 六分类、factory 注册条件（含修复后的飞书口径）。
**Commit:** `test: 同步系统特征测试补齐——老引擎行为黑盒锁定（匹配阈值/变更分类/状态持久化）+ 新框架 matcher/resolver/tracker/calculateChanges 单测；修复 syncFactory 飞书注册条件与 OAuth 写入口径不一致、syncState 吞错`

### T16 同步架构收敛：老引擎迁移至新框架

**Files:** 新 `src/data-layer/sync/feishu/FeishuSyncAdapter.ts`（GUID 状态/pushFilter/错误熔断/进度回调落位）、`src/data-layer/sync/markdownSource.ts`（markdown 注册为 IDataSource：读=TaskRepository，写=updateTaskProperties/任务行创建）；改 `src/data-layer/sync/syncManager.ts`（实现 applyRemoteChanges :348-355 本地写回；执行循环加错误熔断≥5 与 abortSignal）、`src/data-layer/sync/versionTracker.ts`（可注入持久化，飞书接 `.feishu-sync-state.json` 兼容存量状态）、`src/commands/feishuCommands.ts`、`src/settings/builders/SyncSettingsBuilder.ts`、`src/managers/SyncManagerBridge.ts`（自动同步切新引擎）、`src/ui/modals/SyncResultDialog.tsx`（SyncResult 类型改从新框架导出，老路径 re-export 过渡）；删 `src/data-layer/feishu-sync/FeishuTaskSync.ts`（1106 行）+ `taskMapper.ts` 移至 `sync/feishu/`。

**Design（老→新收敛，验收清单来自老 sync() 行为）：** ① markdown 源注册进 syncFactory（localTasks 不再恒空）② applyRemoteChanges 真写回（pull-create 走 serializer 生成任务行入 targetFile、pull-update 走 updateTaskProperties、pull-delete 复用加固后的 deleteTask）③ GUID 写回任务行 metadata（老引擎 :1015-1064 逻辑迁入 markdownSource 写路径）④ versionTracker 持久化注入（存量 .feishu-sync-state.json 记录迁移兼容，键=GUID）⑤ 标题模糊匹配 0.6 并入 taskMatcher（可选策略）⑥ pushFilter（enabledFormats+全局筛选）在 markdownSource.getTasks 侧过滤 ⑦ 错误熔断+abortSignal+onProgress 贯穿 SyncManager 执行循环 ⑧ SyncResult 形状不变（UI 零改）⑨ purgeStaleRecords 等价物。完成判定：T15 特征断言全部改写指向新引擎后仍绿 + feishuCommands/SyncSettingsBuilder/SyncManagerBridge 三处调用点切换 + 全库 grep FeishuTaskSync 零命中。
**Test:** T15 特征测试改写为对新引擎断言（期望值不动）；新增 markdownSource 读写单测（创建/更新/删除任务行 + GUID metadata 回写）。
**Commit:** `refactor: 同步架构收敛——飞书迁移至 sync/ 六阶段框架（markdown 源注册+applyRemoteChanges 写回+GUID 状态持久化兼容+熔断/中止/进度），删除 FeishuTaskSync 老单体（-1106 行），特征测试全程护航`
**风险控制:** 这是最高风险任务；若执行中发现行为差距超出清单（如增量同步语义），回退方案 = 保留老引擎一版、新引擎仅接管 CalDAV 路径，收敛拆为后续迭代——在 commit 与报告中如实说明。

### T17 GitHub Actions CI

**Files:** 新 `.github/workflows/ci.yml`。

**Design:** on push/PR → ubuntu-latest + Node 20：job 单体三步 `npm ci` → `npx eslint .` → `npx jest` → `npm run build`；上传 main.js/styles.css artifact（便于真机安装验证）。npm ci 依赖 package-lock.json（构建产物 main.js 已被 .gitignore 排除，CI 全新装依赖可复现）。
**Test:** 本地等效跑通三命令即预期绿；首次 push 后观察 Actions 运行。
**Commit:** `ci: GitHub Actions——lint+jest+build 三闸门，Node 20，产物 artifact 上传`

### T18 首次安装引导（空库示例卡）

**Files:** 新 `src/ui/components/EmptyVaultGuide.tsx`（BEM 块 `gc-onboarding` 入 bem.ts + onboarding.css）、改 `src/ui/App.tsx`（tasksReady && tasks.length===0 && !settings.onboardingDismissed 时于视图上层渲染）、settings 加 `onboardingDismissed: boolean`、i18n。

**Design:** 居中卡片：① 两种任务语法示例（Tasks `- [ ] 任务 📅 2026-10-12` / Dataview `- [ ] 任务 [due:: 2026-10-12]`，代码样式块）② 当前全局筛选符提示（有则显示）③ 按钮：打开设置 / 不再显示（写 settings）。任意视图下出现（数据为空是全视图共态），任务出现自动消失。
**Test:** jsdom：空任务 → 引导卡渲染且含两种语法；有任务 → 不渲染；点不再显示 → settings.onboardingDismissed=true 且卡消失。
**Commit:** `feat: 首次安装引导——空库时展示任务语法示例卡（Tasks/Dataview 双格式+当前全局筛选符），可关闭持久化`

---

## 验证与交付

1. **每任务**：相关 jest 用例绿 → `npm run build` 成功 → `npx eslint` 变更文件 0 警告 → commit（17 个，T12 已取消）。
2. **阶段末**：全量 `npx jest`（390+ 新增约 60-80 用例）。
3. **收尾**：`git log --oneline` 复核 17 commit；真机冒烟清单交给用户（快捷键、撤销 Notice、深浅色主题下视觉、飞书同步一次、移动端 Dock）。
4. **计划文档归档**：批准后将本计划复制到 `docs/plans/2026-10-12-full-improvement.md`（项目惯例）。

## 明确不做（本轮）

- 甘特图 SVG 虚拟化（40K DOM 问题）——独立大项，本轮虚拟化聚焦 TaskView/侧栏
- 任务 ID 掺内容哈希（CLAUDE.md 记录的 2026-08 有意决策）
- esbuild 升级、设置页 React 化（既有决策保留）
- 多语言扩展（en/zh 维持）
