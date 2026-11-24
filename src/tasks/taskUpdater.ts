import { App, MarkdownView, TFile } from 'obsidian';
import { GCTask } from '../types';
import { serializeTask, TaskUpdates } from './taskSerializer';
import { parseSingleTaskLine } from './taskParser/main';
import { applyTaskChildrenUpdates } from './taskParser/children';
import { resolveScheduledProxyUpdates } from './scheduledFallback';
import { migrateLegacyTimes } from './legacyTimes';
import { flushDirtyMarkdownViews } from '../utils/liveEditorHelper';
import { Logger } from '../utils/logger';

// ==================== 文件级写锁 ====================
// 同一文件的多次更新（如快速连续勾选、批量拖拽）必须串行执行，
// 否则后一次读取会基于前一次写入前的旧内容，整文件覆盖时丢失修改。
const fileWriteLocks = new Map<string, Promise<unknown>>();

export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const previous = fileWriteLocks.get(filePath) ?? Promise.resolve();
	const run = previous.then(fn, fn);
	const tail = run.catch(() => { });
	fileWriteLocks.set(filePath, tail);
	void tail.then(() => {
		if (fileWriteLocks.get(filePath) === tail) fileWriteLocks.delete(filePath);
	});
	return run;
}

// ==================== 未识别字段保留 ====================
// 序列化是整行重建，只输出已知字段。混合格式任务中的未知 dataview
// 内联字段与非结构化 %%注释%% 不在 GCTask 中，重建时会丢失——
// 这里从原行提取并原样追加回写。
const KNOWN_DV_FIELDS = new Set([
	'priority', 'created', 'start', 'scheduled', 'due',
	'cancelled', 'completion', 'repeat', 'guid',
]);

function extractUnrecognizedTokens(line: string): string[] {
	const tokens: string[] = [];
	let m: RegExpExecArray | null;
	// 未知 [key:: value] 内联字段（%%[key::value]%% 形式由 metadataFields 回写，跳过）
	const dvRegex = /\[([a-zA-Z_][\w-]*)::\s*[^\]]*\]/g;
	while ((m = dvRegex.exec(line))) {
		if (KNOWN_DV_FIELDS.has(m[1].toLowerCase())) continue;
		if (line.includes(`%%${m[0]}%%`)) continue;
		tokens.push(m[0]);
	}
	// 非结构化 %%注释%%（%%[key::value]%% 除外）
	const commentRegex = /%%(?!\s*\[)[^%]*%%/g;
	while ((m = commentRegex.exec(line))) {
		tokens.push(m[0]);
	}
	return tokens;
}

// ==================== 写回后即时刷新 ====================
// 文件修改事件要经过 50ms 防抖 + 75ms maxWait 才回流到视图；
// 用户主动写回（右键命令、表单保存等）完成后调用 refreshTaskView
// 立即重建该文件的 Repository 缓存并推送最新任务，消除 1~2s 的延迟感。

interface PluginTaskCache {
	refreshFile: (filePath: string) => Promise<void>;
	getAllTasks: () => GCTask[];
}

function getPluginTaskCache(app: App): PluginTaskCache | null {
	const appWithPlugins = app as App & {
		plugins?: {
			getPlugin?: (id: string) => { taskCache?: PluginTaskCache } | null;
			plugins?: Record<string, { taskCache?: PluginTaskCache } | undefined>;
		};
	};
	return (
		appWithPlugins.plugins?.getPlugin?.('gantt-calendar')?.taskCache ??
		appWithPlugins.plugins?.plugins?.['gantt-calendar']?.taskCache ??
		null
	);
}

/**
 * 写回任务文件后的即时刷新：跳过文件事件防抖，立即更新缓存并通知视图。
 */
export async function refreshTaskView(app: App, filePath: string): Promise<void> {
	try {
		const taskCache = getPluginTaskCache(app);
		if (!taskCache?.refreshFile) return;
		await taskCache.refreshFile(filePath);
		const { useCalendarStore } = await import('../ui/store/calendarStore');
		useCalendarStore.getState().notifyTasksUpdated(taskCache.getAllTasks(), filePath);
	} catch (error) {
		Logger.error('refreshTaskView', 'Immediate refresh after write-back failed:', error);
	}
}

// ==================== 行内容校验 ====================

export function getGlobalTaskFilter(app: App): string {
	const appWithPlugins = app as App & {
		plugins?: {
			getPlugin?: (id: string) => { settings?: { globalTaskFilter?: string } } | null;
			plugins?: Record<string, { settings?: { globalTaskFilter?: string } } | undefined>;
		};
	};
	const plugin =
		appWithPlugins.plugins?.getPlugin?.('gantt-calendar') ??
		appWithPlugins.plugins?.plugins?.['gantt-calendar'];
	return plugin?.settings?.globalTaskFilter || '';
}

function lineMatchesTask(line: string, task: GCTask, globalFilter: string): boolean {
	const parsed = parseSingleTaskLine(line, task.filePath, task.fileName, 1, ['tasks', 'dataview'], globalFilter);
	if (!parsed) return false;
	return parsed.content === task.content || parsed.description === task.description;
}

/**
 * 在重读后的文件中定位任务行，兼容并发编辑导致的行号漂移。
 * 返回 0-based 行索引；找不到返回 -1。
 */
export function locateTaskLine(lines: readonly string[], task: GCTask, globalFilter: string): number {
	return lines.findIndex(line => lineMatchesTask(line, task, globalFilter));
}


/**
 * 确定任务使用的格式
 */
export function determineTaskFormat(
	task: GCTask,
	taskLine: string,
	enabledFormats: string[]
): 'dataview' | 'tasks' {
	// 用户关闭全部格式时兜底为两种都支持，避免把 dataview 行按 tasks 重建而丢字段
	const formats = enabledFormats.length > 0 ? enabledFormats : ['tasks', 'dataview'];
	// 优先使用任务本身的格式
	let formatToUse: 'dataview' | 'tasks' | undefined = task.format;
	if (!formatToUse) {
		if (/\[(priority|created|start|scheduled|due|cancelled|completion)::\s*[^\]]+\]/.test(taskLine)) {
			formatToUse = 'dataview';
		} else if (/([➕🛫⏳📅❌✅])\s*\d{4}-\d{2}-\d{2}/u.test(taskLine)) {
			formatToUse = 'tasks';
		} else if (formats.includes('dataview') && formats.includes('tasks')) {
			// 两者都支持时：如果行中已有方括号则 dataview，否则 tasks
			formatToUse = taskLine.includes('[') ? 'dataview' : 'tasks';
		} else if (formats.includes('dataview')) {
			formatToUse = 'dataview';
		} else {
			formatToUse = 'tasks';
		}
	}
	return formatToUse;
}

/**
 * 读取任务行并返回文件内容和行索引
 */
async function readTaskLine(app: App, task: GCTask): Promise<{ file: TFile; content: string; lines: string[]; taskLineIndex: number }> {
	const file = app.vault.getAbstractFileByPath(task.filePath);
	if (!(file instanceof TFile)) {
		throw new Error(`File not found: ${task.filePath}`);
	}

	await flushDirtyMarkdownViews(app, task.filePath);
	const content = await app.vault.read(file);
	const lines = content.split('\n');

	// 获取任务行的索引（lineNumber 是 1-based）；若上方删行导致越界，交由后续行内容校验重定位
	const taskLineIndex = task.lineNumber - 1;
	if (taskLineIndex < 0) {
		throw new Error(`Invalid line number: ${task.lineNumber}`);
	}

	return { file, content, lines, taskLineIndex };
}

/**
 * 更新任务的完成状态
 *
 * **使用场景**：
 * 1. **BaseViewRenderer.ts:107** - 任务复选框点击事件
 *    - 用户点击任务前的复选框时，调用此函数切换任务完成状态
 *    - 完成时自动添加完成日期（completionDate）
 *    - 取消完成时自动移除完成日期
 *
 * @param app Obsidian App 实例
 * @param task 要更新的任务
 * @param completed 是否完成
 * @param enabledFormats 启用的任务格式
 */
export async function updateTaskCompletion(
	app: App,
	task: GCTask,
	completed: boolean,
	enabledFormats: string[]
): Promise<void> {
	const updates: TaskUpdates = { completed };

	// 标记为完成时添加完成日期，取消完成时移除完成日期
	if (completed) {
		updates.completionDate = new Date();
		// 同步更新状态为 done
		updates.status = 'done';
	} else {
		updates.completionDate = null;
		// 取消完成时，如果当前状态是 done，则改为 todo；其他状态保持不变
		if (task.status === 'done') {
			updates.status = 'todo';
		}
	}

	await updateTaskProperties(app, task, updates, enabledFormats);
}

/**
 * 更新任务的日期字段（由日期筛选字段指定）
 *
 * **使用场景**：
 * 1. **WeekView.ts:89** - 拖拽任务到不同日期时，更新任务的日期字段
 * 2. **contextMenu/commands/cancelTask.ts:16** - 右键菜单取消任务时，设置取消日期
 *
 * @param app Obsidian App
 * @param task 任务对象
 * @param dateFieldName 日期字段名（dueDate, startDate, scheduledDate, createdDate, cancelledDate, completionDate）
 * @param newDate 新的日期值
 * @param enabledFormats 启用的任务格式
 */
export async function updateTaskDateField(
	app: App,
	task: GCTask,
	dateFieldName: string,
	newDate: Date,
	enabledFormats: string[]
): Promise<void> {
	const updates: TaskUpdates = {
		[dateFieldName]: newDate
	};

	await updateTaskProperties(app, task, updates, enabledFormats);
}

// ==================== 写回后光标 / 滚动位置保持 ====================
// vault.modify 会让当前 Markdown 编辑器重排文本，光标与滚动位置可能跳动。
// 全程可选链 + duck typing，Jest 的 mock App 没有 workspace 时直接跳过。

interface EditorSnapshotTarget {
	getCursor: () => { line: number; ch: number };
	setCursor: (pos: { line: number; ch: number }) => void;
	getScrollInfo?: () => { top: number; left: number };
	scrollTo?: (x: number, y: number) => void;
	lineCount?: () => number;
}

interface MarkdownViewLike {
	file?: { path?: string } | null;
	editor?: EditorSnapshotTarget | null;
}

interface EditorSnapshot {
	editor: EditorSnapshotTarget;
	filePath: string;
	cursor: { line: number; ch: number };
	scroll: { top: number; left: number } | null;
}

function activeMarkdownView(app: App): MarkdownViewLike | null {
	const workspace = (app as App & {
		workspace?: {
			// Obsidian 真实 API：按类型取活动视图（本插件其它地方也用这个）
			getActiveViewOfType?: <T>(type: new (...args: never[]) => T) => T | null;
			// 兼容只模拟 getActiveView 的测试 App
			getActiveView?: () => unknown;
		};
	}).workspace;
	const view = (
		workspace?.getActiveViewOfType?.(MarkdownView)
		?? workspace?.getActiveView?.()
	) as MarkdownViewLike | null | undefined;
	if (!view?.file || !view.editor) return null;
	if (typeof view.editor.getCursor !== 'function' || typeof view.editor.setCursor !== 'function') return null;
	return view;
}

function snapshotEditorView(app: App, filePath: string): EditorSnapshot | null {
	const view = activeMarkdownView(app);
	if (!view || view.file?.path !== filePath) return null;
	const editor = view.editor!;
	try {
		return {
			editor,
			filePath,
			cursor: editor.getCursor(),
			scroll: typeof editor.getScrollInfo === 'function' ? editor.getScrollInfo() : null,
		};
	} catch {
		return null;
	}
}

function restoreEditorView(app: App, snapshot: EditorSnapshot): void {
	const restore = () => {
		try {
			const view = activeMarkdownView(app);
			// 编辑器已关闭 / 被替换 / 切到别的文件 → 静默跳过
			if (!view || view.editor !== snapshot.editor || view.file?.path !== snapshot.filePath) return;
			const editor = snapshot.editor;
			const lineCount = typeof editor.lineCount === 'function' ? editor.lineCount() : snapshot.cursor.line + 1;
			const line = Math.max(0, Math.min(snapshot.cursor.line, Math.max(0, lineCount - 1)));
			editor.setCursor({ line, ch: snapshot.cursor.ch });
			if (snapshot.scroll && typeof editor.scrollTo === 'function') {
				editor.scrollTo(snapshot.scroll.left, snapshot.scroll.top);
			}
		} catch {
			// 编辑器在写回过程中被销毁，忽略
		}
	};
	// 真机用 setTimeout(0)：等 vault.modify 触发的编辑器刷新完成后再恢复；
	// queueMicrotask 太快，会被随后的刷新覆盖。Jest/node 环境回落到全局 setTimeout。
	if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
		window.setTimeout(restore, 0);
	} else {
		setTimeout(restore, 0);
	}
}

/**
 * 批量更新任务属性（优先级、完成状态、各日期字段）
 * 未提供的字段不做更改；传入 null 的日期字段表示清除该字段。
 */
export async function updateTaskProperties(
	app: App,
	proxiedTask: GCTask,
	proxiedUpdates: TaskUpdates,
	enabledFormats: string[]
): Promise<void> {
	if (proxiedTask.fileTask) {
		throw new Error(`File-based task cannot be updated as a task line: ${proxiedTask.filePath}`);
	}
	// 计划日期回退代理：视图字段上的修改还原为对 ⏳ 计划日期 + 时间前缀的修改
	const { task, updates: resolvedUpdates } = resolveScheduledProxyUpdates(proxiedTask, proxiedUpdates);
	// 起止只管日期：旧写法里起止 / ⏳ 上的时刻迁移为 ⏳ + 时间前缀，并只留日期
	const updates = migrateLegacyTimes(task, resolvedUpdates);
	// 同文件更新串行化，消除读-改-写竞态（P0）
	await withFileLock(task.filePath, async () => {
		const startTime = performance.now();
		Logger.debug('taskUpdater', 'updateTaskProperties called:', {
			task: task.description || task.content,
			filePath: task.filePath,
			lineNumber: task.lineNumber,
			updates,
			format: task.format
		});

		const { file, lines, taskLineIndex: rawIndex } = await readTaskLine(app, task);

		// 行号漂移校验（P0）：文件被并发编辑后 lineNumber 可能指向别的行或越界（上方删行）。
		// 校验失败时在文件内重定位；找不到则报错并自动刷新缓存，绝不盲写。
		const globalFilter = getGlobalTaskFilter(app);
		let taskLineIndex = rawIndex;
		const inBounds = taskLineIndex >= 0 && taskLineIndex < lines.length;
		if (!inBounds || !lineMatchesTask(lines[taskLineIndex], task, globalFilter)) {
			Logger.warn('taskUpdater', `Line drift detected at ${task.filePath}:${task.lineNumber}, relocating...`);
			const found = lines.findIndex(line => lineMatchesTask(line, task, globalFilter));
			if (found === -1) {
				void refreshTaskView(app, task.filePath);
				throw new Error(
					`Task not found in file ${task.filePath}:${task.lineNumber}. ` +
					`File changed externally; task cache will refresh.`
				);
			}
			taskLineIndex = found;
		}

		const taskLine = lines[taskLineIndex];

		Logger.debug('taskUpdater', 'Original task line:', taskLine);

		const hasParentUpdates = Object.keys(updates).some(
			(k) => k !== 'subtaskToggles' && k !== 'bulletText'
		);

		if (hasParentUpdates) {
			// 确定任务格式
			const formatToUse = determineTaskFormat(task, taskLine, enabledFormats);

			// 提取列表标记和缩进。与 step1 解析正则保持一致：
			// 支持 -/*/+/数字列表、引用块前缀（>）、自定义单字符复选框状态
			const listMatch = taskLine.match(/^([\s\t>]*)([-*+]|\d+[.)])\s+\[.\]\s*/);
			if (!listMatch) {
				throw new Error('Invalid task format: cannot find list marker');
			}

			const indent = listMatch[1];  // 缩进（含引用前缀）
			const listMarker = listMatch[2];  // 列表标记

			// 使用新的序列化函数重建任务行（只返回任务内容部分，不包含列表标记）
			// 序列化函数会直接从插件设置中获取全局过滤器
			const taskContent = serializeTask(
				app,
				task,
				updates,
				formatToUse
			);

			Logger.debug('taskUpdater', 'Serialized task content:', taskContent);

			// 拼接完整的任务行：缩进 + 列表标记 + 空格 + 任务内容
			let finalTaskLine = `${indent}${listMarker} ${taskContent}`;

			// 保留未识别字段（P0 混合格式数据丢失）：未知的 [key:: value]
			// 内联字段与 %%注释%% 不参与序列化，从原行原样追加
			const preservedTokens = extractUnrecognizedTokens(taskLine)
				.filter(token => !finalTaskLine.includes(token));
			if (preservedTokens.length > 0) {
				finalTaskLine = `${finalTaskLine} ${preservedTokens.join(' ')}`;
			}

			Logger.debug('taskUpdater', 'Final task line:', finalTaskLine);

			// 写回父任务行
			lines[taskLineIndex] = finalTaskLine;
		}

		// 同步应用一级子任务勾选变更与多级 bullet items 更新（完整保留未改动子任务及其下级）
		applyTaskChildrenUpdates(lines, taskLineIndex, {
			subtaskToggles: updates.subtaskToggles,
			bulletText: updates.bulletText,
			lineDelta: taskLineIndex - rawIndex,
		});

		const newContent = lines.join('\n');

		// 写回前快照当前编辑器位置（仅当活动编辑器正是目标文件时）
		const editorSnapshot = snapshotEditorView(app, task.filePath);

		const writeStart = performance.now();
		await app.vault.modify(file, newContent);
		const writeElapsed = performance.now() - writeStart;
		if (editorSnapshot) restoreEditorView(app, editorSnapshot);

		const totalElapsed = performance.now() - startTime;
		Logger.debug('taskUpdater', `Task updated in ${totalElapsed.toFixed(2)}ms (write: ${writeElapsed.toFixed(2)}ms)`);
	});
	// 写回完成后统一立即刷新该文件的缓存并通知视图，确保所有调用入口（含编辑弹窗、甘特拖拽等）即时生效
	await refreshTaskView(app, task.filePath);
}
