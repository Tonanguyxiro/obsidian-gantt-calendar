/**
 * DataviewDataSource - 基于 Dataview 内存索引的主数据源
 *
 * 直接读取 Obsidian Dataview 插件已索引的 `api.pages().file.tasks` / `api.page(path)`，
 * 并在边界处立即转换为本插件内部的 `GCTask`（绝不持有 Dataview 私有对象）。
 * 配合 `parseSingleTaskLine` / `parseTasksFromListItems` 保证与 `MarkdownDataSource`
 * 在 `globalTaskFilter`、`plannerTime`、`datePrecision`、`repeat`、自定义状态及 `cancelledDate` 上 100% 一致。
 */

import { App, EventRef, ListItemCache, TFile } from 'obsidian';
import { parseSingleTaskLine, parseTasksFromListItems } from '../tasks/taskParser/main';
import { parseTaskLine } from '../tasks/taskParser/step1';
import type { TaskFormatType } from '../tasks/taskSerializerSymbols';
import { EventBus } from './EventBus';
import type { GCTask } from '../types';
import type { DataSourceChanges, DataSourceConfig, SyncStatus, TaskChanges } from './types';
import { ChangeEventHandler, IDataSource } from './IDataSource';
import { Logger } from '../utils/logger';

/** Dataview 任务项最小结构契约（仅在边界读取原语，不保留原对象） */
export interface DataviewTaskLike {
	path?: unknown;
	line?: unknown;
	status?: unknown;
	symbol?: unknown;
	text?: unknown;
	completed?: unknown;
}

interface DataviewDataArrayLike<T> extends Iterable<T> {
	array?: () => T[];
	values?: T[];
}

interface DataviewPageLike {
	file?: {
		path?: unknown;
		name?: unknown;
		mtime?: unknown;
		tasks?: DataviewDataArrayLike<DataviewTaskLike> | DataviewTaskLike[];
	};
}

interface DataviewPagesResult extends Iterable<DataviewPageLike> {
	array?: () => DataviewPageLike[];
	values?: DataviewPageLike[];
	file?: {
		tasks?: DataviewDataArrayLike<DataviewTaskLike> | DataviewTaskLike[];
	};
}

export interface DataviewApiLike {
	pages: (query?: string) => DataviewPagesResult;
	page?: (path: string) => DataviewPageLike | undefined;
}

interface DataviewPluginLike {
	api?: DataviewApiLike;
	index?: { initialized?: boolean };
}

interface AppWithPlugins extends App {
	plugins?: {
		plugins?: Record<string, unknown>;
		enabledPlugins?: Set<string>;
	};
}

interface DataviewFileCache {
	taskIds: string[];
	taskFingerprints: string[];
	lastModified: number;
	taskCount: number;
	source: 'dataview' | 'direct';
}

function generateTaskId(task: GCTask): string {
	return `${task.filePath}:${task.lineNumber}`;
}

function stripMdExtension(name: string): string {
	return name.replace(/\.md$/i, '');
}

function fingerprintTask(task: GCTask): string {
	return [
		task.content,
		task.completed ? '1' : '0',
		task.cancelled ? '1' : '0',
		task.status || '',
		task.priority || '',
		task.format || '',
		task.repeat || '',
		task.createdDate?.getTime() ?? '',
		task.startDate?.getTime() ?? '',
		task.scheduledDate?.getTime() ?? '',
		task.dueDate?.getTime() ?? '',
		task.cancelledDate?.getTime() ?? '',
		task.completionDate?.getTime() ?? '',
		task.datePrecision ? JSON.stringify(task.datePrecision) : '',
		task.metadataFields ? JSON.stringify(task.metadataFields) : '',
	].join('|');
}

function toArray<T>(collection: DataviewDataArrayLike<T> | T[] | undefined | null): T[] {
	if (!collection) return [];
	if (Array.isArray(collection)) return collection;
	if (typeof collection.array === 'function') return collection.array();
	if (Array.isArray(collection.values)) return collection.values;
	if (typeof (collection as Iterable<T>)[Symbol.iterator] === 'function') {
		return Array.from(collection);
	}
	return [];
}

function extractMtimeMs(mtime: unknown): number | null {
	if (typeof mtime === 'number' && !Number.isNaN(mtime)) return mtime;
	if (mtime && typeof mtime === 'object') {
		const obj = mtime as { toMillis?: () => number; ts?: number; valueOf?: () => unknown };
		if (typeof obj.toMillis === 'function') {
			const ms = obj.toMillis();
			if (typeof ms === 'number' && !Number.isNaN(ms)) return ms;
		}
		if (typeof obj.ts === 'number' && !Number.isNaN(obj.ts)) return obj.ts;
		if (typeof obj.valueOf === 'function') {
			const val = obj.valueOf();
			if (typeof val === 'number' && !Number.isNaN(val)) return val;
		}
	}
	return null;
}

function getDataviewPlugin(app: App): DataviewPluginLike | null {
	const pluginsApi = (app as AppWithPlugins).plugins;
	if (!pluginsApi) return null;
	if (pluginsApi.enabledPlugins && !pluginsApi.enabledPlugins.has('dataview')) {
		return null;
	}
	const dv = pluginsApi.plugins?.dataview as DataviewPluginLike | undefined;
	return dv ?? null;
}

/**
 * 判断 Dataview 插件是否已安装、启用且暴露了 `api.pages()`。
 * 若 Dataview 正在首扫初始化（`index.initialized === false`），仍返回 true，
 * 以便 TaskStore 区分「插件不可用」与「等待 `dataview:index-ready`」。
 */
export function isDataviewPluginEnabled(app: App): boolean {
	const dv = getDataviewPlugin(app);
	return Boolean(dv?.api && typeof dv.api.pages === 'function');
}

/**
 * 判断 Dataview 索引数据源当前是否已就绪可用（已安装、已启用、API 存在且索引已完成初始化）。
 */
export function isDataviewIndexingAvailable(app: App): boolean {
	const dv = getDataviewPlugin(app);
	if (!dv?.api || typeof dv.api.pages !== 'function') return false;
	return dv.index?.initialized !== false;
}

export class DataviewDataSource implements IDataSource {
	readonly sourceId = 'dataview';
	readonly sourceName = 'Dataview Index';
	readonly isReadOnly = false;

	private app: App;
	private config: DataSourceConfig;
	private eventBus: EventBus;
	private onFatalError?: (error: unknown) => void;
	private changeHandler?: ChangeEventHandler;

	private cache: Map<string, DataviewFileCache> = new Map();
	private runningRuns: Map<string, Promise<void>> = new Map();
	private queuedRuns: Map<string, Promise<void>> = new Map();
	private metadataEventRefs: EventRef[] = [];
	private watchersRegistered = false;

	constructor(
		app: App,
		eventBus: EventBus,
		config: DataSourceConfig,
		onFatalError?: (error: unknown) => void
	) {
		this.app = app;
		this.eventBus = eventBus;
		this.config = config;
		this.onFatalError = onFatalError;
	}

	async initialize(config: DataSourceConfig): Promise<void> {
		if (!isDataviewIndexingAvailable(this.app)) {
			throw new Error('Dataview index is not available or not ready');
		}

		const configChanged =
			this.config.globalFilter !== config.globalFilter ||
			(this.config.enabledFormats || []).join(',') !== (config.enabledFormats || []).join(',');
		if (configChanged) {
			this.cache.clear();
		}
		this.config = config;

		const scanStartTime = performance.now();
		const { tasksByFile, allTasks } = this.readGroupedTasksFromDataview();

		if (this.cache.size === 0) {
			for (const [filePath, tasks] of tasksByFile) {
				this.cache.set(filePath, this.buildFileCache(filePath, tasks, 'dataview'));
			}
			if (!this.watchersRegistered) {
				this.setupWatchers();
				this.watchersRegistered = true;
			}
			await this.changeHandler?.(
				{
					sourceId: this.sourceId,
					created: allTasks,
					updated: [],
					deleted: [],
				},
				{ initial: true }
			);
		} else {
			if (!this.watchersRegistered) {
				this.setupWatchers();
				this.watchersRegistered = true;
			}
			await this.reconcileGroupedTasks(tasksByFile, true);
		}

		const elapsed = performance.now() - scanStartTime;
		Logger.stats('DataviewDataSource', `initialize() completed in ${elapsed.toFixed(2)}ms (${allTasks.length} tasks)`);
	}

	async getTasks(): Promise<GCTask[]> {
		const { allTasks } = this.readGroupedTasksFromDataview();
		return allTasks;
	}

	onChange(handler: ChangeEventHandler): void {
		this.changeHandler = handler;
	}

	async createTask(_task: GCTask): Promise<string> {
		throw new Error('Creating tasks directly via DataviewDataSource is not supported');
	}

	async updateTask(_taskId: string, _changes: TaskChanges): Promise<void> {
		throw new Error('Updating tasks directly via DataviewDataSource is not supported');
	}

	async deleteTask(_taskId: string): Promise<void> {
		throw new Error('Deleting tasks directly via DataviewDataSource is not supported');
	}

	async getSyncStatus(): Promise<SyncStatus> {
		return {
			syncDirection: 'import-only',
			conflictResolution: 'local-win',
		};
	}

	/**
	 * 写回后立即刷新单文件缓存：直接读取该文件并解析，避免等待 Dataview 后台 Worker 重建。
	 * 随后 Dataview Worker 完成并触发 `dataview:metadata-change` 时指纹已一致，自动跳过无重复事件。
	 */
	refreshFile(filePath: string): Promise<void> {
		return this.enqueueFileRun(filePath, () => this.runDirectFileRefresh(filePath));
	}

	destroy(): void {
		for (const ref of this.metadataEventRefs) {
			this.app.metadataCache?.offref?.(ref);
		}
		this.metadataEventRefs = [];
		this.watchersRegistered = false;
		this.runningRuns.clear();
		this.queuedRuns.clear();
		this.cache.clear();
	}

	// ==================== Dataview 读取与边界转换 ====================

	private getApi(): DataviewApiLike | null {
		const dv = getDataviewPlugin(this.app);
		return dv?.api && typeof dv.api.pages === 'function' ? dv.api : null;
	}

	private readGroupedTasksFromDataview(): { tasksByFile: Map<string, GCTask[]>; allTasks: GCTask[] } {
		const api = this.getApi();
		if (!api) {
			throw new Error('Dataview API unavailable');
		}

		const pagesResult = api.pages();
		const rawTasks: DataviewTaskLike[] = [];

		if (pagesResult?.file?.tasks !== undefined) {
			rawTasks.push(...toArray(pagesResult.file.tasks));
		} else {
			for (const page of toArray(pagesResult)) {
				const pageTasks = toArray(page?.file?.tasks);
				if (pageTasks.length > 0) {
					rawTasks.push(...pageTasks);
				}
			}
		}

		const tasksByFile = new Map<string, GCTask[]>();
		const seenPerFile = new Map<string, Set<number>>();

		for (const rawTask of rawTasks) {
			const gcTask = this.convertDataviewTask(rawTask);
			if (!gcTask) continue;

			let linesSeen = seenPerFile.get(gcTask.filePath);
			if (!linesSeen) {
				linesSeen = new Set();
				seenPerFile.set(gcTask.filePath, linesSeen);
			}
			if (linesSeen.has(gcTask.lineNumber)) continue;
			linesSeen.add(gcTask.lineNumber);

			let list = tasksByFile.get(gcTask.filePath);
			if (!list) {
				list = [];
				tasksByFile.set(gcTask.filePath, list);
			}
			list.push(gcTask);
		}

		const allTasks: GCTask[] = [];
		for (const list of tasksByFile.values()) {
			list.sort((a, b) => a.lineNumber - b.lineNumber);
			allTasks.push(...list);
		}

		return { tasksByFile, allTasks };
	}

	private readPageFromDataview(filePath: string): DataviewPageLike | undefined {
		const api = this.getApi();
		if (!api) {
			throw new Error('Dataview API unavailable');
		}
		if (typeof api.page === 'function') {
			return api.page(filePath);
		}
		const pages = toArray(api.pages());
		return pages.find((p) => p?.file?.path === filePath);
	}

	/**
	 * 边界转换：仅提取 Dataview 任务项的原语字段，重建首行文本后交由 `parseSingleTaskLine` 解析，
	 * 确保 `globalTaskFilter`、`plannerTime`、`datePrecision`、`repeat`、自定义状态与 `cancelledDate`
	 * 与 `MarkdownDataSource` 完全一致，且不持有任何 Dataview 私有对象引用。
	 */
	private convertDataviewTask(rawTask: DataviewTaskLike | null | undefined): GCTask | null {
		if (!rawTask || typeof rawTask !== 'object') return null;
		const filePath = typeof rawTask.path === 'string' ? rawTask.path : '';
		const line = typeof rawTask.line === 'number' && Number.isFinite(rawTask.line) ? rawTask.line : -1;
		if (!filePath || line < 0) return null;

		const rawText = typeof rawTask.text === 'string' ? rawTask.text : '';
		const firstLineEnd = rawText.search(/\r?\n/);
		const firstLine = firstLineEnd >= 0 ? rawText.slice(0, firstLineEnd) : rawText;

		const symbol = typeof rawTask.symbol === 'string' && rawTask.symbol ? rawTask.symbol : '-';
		const status =
			typeof rawTask.status === 'string'
				? rawTask.status
				: rawTask.completed === true
					? 'x'
					: ' ';
		const reconstructedLine = `${symbol} [${status}] ${firstLine}`;

		const fileName = this.resolveFileBasename(filePath);
		const enabledFormats = (this.config.enabledFormats as TaskFormatType[] | undefined) || ['tasks', 'dataview'];

		return parseSingleTaskLine(
			reconstructedLine,
			filePath,
			fileName,
			line + 1,
			enabledFormats,
			this.config.globalFilter
		);
	}

	private resolveFileBasename(filePath: string): string {
		const abstractFile = this.app.vault?.getAbstractFileByPath?.(filePath);
		if (abstractFile instanceof TFile) {
			return abstractFile.basename;
		}
		if (
			abstractFile &&
			typeof abstractFile === 'object' &&
			'basename' in abstractFile &&
			typeof (abstractFile as { basename?: unknown }).basename === 'string'
		) {
			return (abstractFile as { basename: string }).basename;
		}
		return stripMdExtension(filePath.split('/').pop() || '');
	}

	private getFileMtime(filePath: string, dvPage?: DataviewPageLike): number {
		const abstractFile = this.app.vault?.getAbstractFileByPath?.(filePath);
		const statMtime = (abstractFile as { stat?: { mtime?: number } } | null | undefined)?.stat?.mtime;
		if (typeof statMtime === 'number' && !Number.isNaN(statMtime)) {
			return statMtime;
		}
		const dvMtime = extractMtimeMs(dvPage?.file?.mtime);
		return dvMtime ?? Date.now();
	}

	private buildFileCache(
		filePath: string,
		tasks: GCTask[],
		source: 'dataview' | 'direct',
		dvPage?: DataviewPageLike
	): DataviewFileCache {
		return {
			taskIds: tasks.map(generateTaskId),
			taskFingerprints: tasks.map(fingerprintTask),
			lastModified: this.getFileMtime(filePath, dvPage),
			taskCount: tasks.length,
			source,
		};
	}

	// ==================== 监听与增量更新 ====================

	private setupWatchers(): void {
		const metadataCache = this.app.metadataCache as unknown as {
			on?: (name: string, cb: (...args: unknown[]) => void) => EventRef;
		};
		if (typeof metadataCache?.on !== 'function') return;

		const ref = metadataCache.on('dataview:metadata-change', (op: unknown, file?: unknown, oldPath?: unknown) => {
			this.handleMetadataChange(op, file, oldPath);
		});
		this.metadataEventRefs.push(ref);
	}

	private handleMetadataChange(op: unknown, file?: unknown, oldPath?: unknown): void {
		try {
			if (typeof op === 'string') {
				const targetPath =
					typeof file === 'string'
						? file
						: file && typeof (file as { path?: unknown }).path === 'string'
							? (file as { path: string }).path
							: undefined;

				if (op === 'delete') {
					if (targetPath) {
						void this.enqueueFileRun(targetPath, () => this.runFileDeletion(targetPath));
					}
					return;
				}

				if (op === 'rename') {
					const prevPath = typeof oldPath === 'string' ? oldPath : undefined;
					if (
						prevPath &&
						(this.cache.has(prevPath) || this.runningRuns.has(prevPath) || this.queuedRuns.has(prevPath))
					) {
						void this.enqueueFileRun(prevPath, () => this.runDataviewFileUpdate(prevPath));
					}
					if (targetPath) {
						void this.enqueueFileRun(targetPath, () => this.runDataviewFileUpdate(targetPath));
					}
					return;
				}

				if (targetPath) {
					if (!targetPath.endsWith('.md')) return;
					if (!this.cache.has(targetPath)) {
						const page = this.readPageFromDataview(targetPath);
						if (!page || toArray(page.file?.tasks).length === 0) return;
					}
					void this.enqueueFileRun(targetPath, () => this.runDataviewFileUpdate(targetPath));
					return;
				}
			} else if (op && typeof op === 'object' && typeof (op as { path?: unknown }).path === 'string') {
				const targetPath = (op as { path: string }).path;
				if (!targetPath.endsWith('.md')) return;
				void this.enqueueFileRun(targetPath, () => this.runDataviewFileUpdate(targetPath));
				return;
			}

			// 无参数或无路径触发时，执行轻量增量对账
			const { tasksByFile } = this.readGroupedTasksFromDataview();
			void this.reconcileGroupedTasks(tasksByFile, false);
		} catch (error) {
			Logger.error('DataviewDataSource', 'Error handling dataview:metadata-change:', error);
			this.onFatalError?.(error);
		}
	}

	private enqueueFileRun(filePath: string, taskFn: () => Promise<void>): Promise<void> {
		const queued = this.queuedRuns.get(filePath);
		if (queued) return queued;

		const running = this.runningRuns.get(filePath);
		if (!running) return this.startFileRun(filePath, taskFn);

		const next = running.then(() => {
			this.queuedRuns.delete(filePath);
			return this.startFileRun(filePath, taskFn);
		});
		this.queuedRuns.set(filePath, next);
		return next;
	}

	private startFileRun(filePath: string, taskFn: () => Promise<void>): Promise<void> {
		const run = taskFn().finally(() => {
			if (this.runningRuns.get(filePath) === run) {
				this.runningRuns.delete(filePath);
			}
		});
		this.runningRuns.set(filePath, run);
		return run;
	}

	private async runFileDeletion(filePath: string): Promise<void> {
		const oldCache = this.cache.get(filePath);
		this.cache.delete(filePath);
		if (oldCache && this.changeHandler) {
			await this.changeHandler({
				sourceId: this.sourceId,
				created: [],
				updated: [],
				deleted: [],
				deletedFilePaths: [filePath],
			});
		}
	}

	private async runDataviewFileUpdate(filePath: string): Promise<void> {
		try {
			if (!isDataviewPluginEnabled(this.app)) {
				throw new Error('Dataview plugin disabled or unavailable');
			}

			const oldCache = this.cache.get(filePath);
			const page = this.readPageFromDataview(filePath);
			const hasVaultLookup = typeof this.app.vault?.getAbstractFileByPath === 'function';
			const currentFile = hasVaultLookup ? this.app.vault.getAbstractFileByPath(filePath) : undefined;

			// 若 vault 已不存在该文件且 Dataview 也不再包含该页 → 视为已删除/重命名清理
			if (hasVaultLookup && !currentFile && !page) {
				await this.runFileDeletion(filePath);
				return;
			}

			// 若此前通过 refreshFile 直接解析了更新的磁盘版本，忽略较早 mtime 的 Dataview 延迟事件
			const dvMtime = extractMtimeMs(page?.file?.mtime);
			if (oldCache?.source === 'direct' && dvMtime !== null && dvMtime < oldCache.lastModified) {
				return;
			}

			const rawTasks = toArray(page?.file?.tasks);
			const newTasks: GCTask[] = [];
			const seenLines = new Set<number>();
			for (const rawTask of rawTasks) {
				const parsed = this.convertDataviewTask(rawTask);
				if (!parsed || parsed.filePath !== filePath) continue;
				if (seenLines.has(parsed.lineNumber)) continue;
				seenLines.add(parsed.lineNumber);
				newTasks.push(parsed);
			}
			newTasks.sort((a, b) => a.lineNumber - b.lineNumber);

			await this.commitFileTasks(filePath, oldCache, newTasks, 'dataview', page);
		} catch (error) {
			Logger.error('DataviewDataSource', `Error processing dataview update for ${filePath}:`, error);
			this.onFatalError?.(error);
		}
	}

	private async runDirectFileRefresh(filePath: string): Promise<void> {
		const abstractFile = this.app.vault?.getAbstractFileByPath?.(filePath);
		const oldCache = this.cache.get(filePath);

		if (typeof this.app.vault?.getAbstractFileByPath === 'function' && !abstractFile) {
			await this.runFileDeletion(filePath);
			return;
		}

		const isFileLike =
			abstractFile instanceof TFile ||
			(!!abstractFile && typeof abstractFile === 'object' && !('children' in abstractFile));

		const vaultReader = this.app.vault as unknown as { read?: (file: object) => Promise<string> } | undefined;
		if (isFileLike && typeof vaultReader?.read === 'function') {
			const content = await vaultReader.read(abstractFile);
			const lines = content.split('\n');
			const listItems: ListItemCache[] = [];
			for (let i = 0; i < lines.length; i++) {
				if (parseTaskLine(lines[i])) {
					listItems.push({
						position: {
							start: { line: i, col: 0, offset: 0 },
							end: { line: i, col: lines[i].length, offset: 0 },
						},
					} as ListItemCache);
				}
			}
			const enabledFormats =
				(this.config.enabledFormats as TaskFormatType[] | undefined) || ['tasks', 'dataview'];
			const fileRef = { path: filePath, basename: this.resolveFileBasename(filePath) };
			const newTasks =
				listItems.length > 0
					? parseTasksFromListItems(fileRef, lines, listItems, enabledFormats, this.config.globalFilter)
					: [];

			await this.commitFileTasks(filePath, oldCache, newTasks, 'direct');
			return;
		}

		// 若测试 mock 未提供 TFile / vault.read，回退到 Dataview 页面读取
		await this.runDataviewFileUpdate(filePath);
	}

	private async commitFileTasks(
		filePath: string,
		oldCache: DataviewFileCache | undefined,
		newTasks: GCTask[],
		source: 'dataview' | 'direct',
		dvPage?: DataviewPageLike
	): Promise<void> {
		const nextCache = newTasks.length > 0 ? this.buildFileCache(filePath, newTasks, source, dvPage) : undefined;
		if (nextCache) {
			this.cache.set(filePath, nextCache);
		} else {
			this.cache.delete(filePath);
		}

		if (!this.changeHandler) return;

		const changes = this.detectChangesByIds(oldCache, newTasks);
		if (!changes) return;

		changes.fileSnapshots = [{ filePath, taskIds: nextCache?.taskIds ?? [] }];
		await this.changeHandler(changes);
	}

	private async reconcileGroupedTasks(tasksByFile: Map<string, GCTask[]>, initial: boolean): Promise<void> {
		const deletedFilePaths: string[] = [];
		for (const cachedPath of Array.from(this.cache.keys())) {
			if (!tasksByFile.has(cachedPath)) {
				this.cache.delete(cachedPath);
				deletedFilePaths.push(cachedPath);
			}
		}

		const created: GCTask[] = [];
		const updated: DataSourceChanges['updated'] = [];
		const deleted: GCTask[] = [];
		const fileSnapshots: NonNullable<DataSourceChanges['fileSnapshots']> = [];

		for (const [filePath, newTasks] of tasksByFile) {
			const oldCache = this.cache.get(filePath);
			const nextCache = this.buildFileCache(filePath, newTasks, 'dataview');
			this.cache.set(filePath, nextCache);

			const fileChanges = this.detectChangesByIds(oldCache, newTasks);
			if (fileChanges) {
				created.push(...fileChanges.created);
				updated.push(...fileChanges.updated);
				deleted.push(...fileChanges.deleted);
				fileSnapshots.push({ filePath, taskIds: nextCache.taskIds });
			}
		}

		if (
			initial ||
			created.length > 0 ||
			updated.length > 0 ||
			deleted.length > 0 ||
			deletedFilePaths.length > 0
		) {
			await this.changeHandler?.(
				{
					sourceId: this.sourceId,
					created,
					updated,
					deleted,
					deletedFilePaths: deletedFilePaths.length > 0 ? deletedFilePaths : undefined,
					fileSnapshots: fileSnapshots.length > 0 ? fileSnapshots : undefined,
				},
				initial ? { initial: true } : undefined
			);
		}
	}

	private detectChangesByIds(
		oldCache: DataviewFileCache | undefined,
		newTasks: GCTask[]
	): DataSourceChanges | null {
		const oldTaskIds = oldCache?.taskIds || [];
		const oldFingerprints = oldCache?.taskFingerprints;
		const oldIdSet = new Set(oldTaskIds);
		const oldFingerprintMap = oldFingerprints
			? new Map(oldTaskIds.map((id, i) => [id, oldFingerprints[i]]))
			: undefined;
		const newIdMap = new Map(newTasks.map((t) => [generateTaskId(t), t]));

		const changes: DataSourceChanges = {
			sourceId: this.sourceId,
			created: [],
			updated: [],
			deleted: [],
		};

		for (const [id, task] of newIdMap) {
			if (!oldIdSet.has(id)) {
				changes.created.push(task);
			}
		}

		for (const id of oldTaskIds) {
			if (!newIdMap.has(id)) {
				const sep = id.lastIndexOf(':');
				const filePath = sep > 0 ? id.slice(0, sep) : id;
				const lineNumber = sep > 0 ? parseInt(id.slice(sep + 1), 10) : 0;
				changes.deleted.push({
					filePath,
					lineNumber,
					fileName: stripMdExtension(filePath.split('/').pop() || ''),
					content: '',
					description: '',
					completed: false,
					priority: 'normal',
				});
			}
		}

		for (const [id, newTask] of newIdMap) {
			if (oldIdSet.has(id)) {
				const oldFp = oldFingerprintMap?.get(id);
				if (oldFingerprintMap && oldFp === fingerprintTask(newTask)) {
					continue;
				}
				changes.updated.push({
					id,
					changes: {},
					task: newTask,
				});
			}
		}

		// 行号漂移指纹重配：把伪 deleted + created 降级为原地 updated
		if (oldFingerprintMap && oldFingerprintMap.size > 0) {
			const unmatchedOld = new Map<string, string>();
			for (const id of oldTaskIds) {
				if (!newIdMap.has(id)) {
					const fp = oldFingerprintMap.get(id);
					if (fp !== undefined && !unmatchedOld.has(fp)) {
						unmatchedOld.set(fp, id);
					}
				}
			}

			if (unmatchedOld.size > 0 && unmatchedOld.size <= 500) {
				const unmatchedNew = new Map<string, GCTask>();
				for (const [id, task] of newIdMap) {
					if (!oldIdSet.has(id)) {
						const fp = fingerprintTask(task);
						if (!unmatchedNew.has(fp)) {
							unmatchedNew.set(fp, task);
						}
					}
				}

				for (const [fp, oldId] of unmatchedOld) {
					const newTask = unmatchedNew.get(fp);
					if (!newTask) continue;
					const newId = generateTaskId(newTask);
					unmatchedOld.delete(fp);
					unmatchedNew.delete(fp);

					changes.deleted = changes.deleted.filter((d) => generateTaskId(d) !== oldId);
					const newTaskIdx = changes.created.findIndex((c) => generateTaskId(c) === newId);
					if (newTaskIdx !== -1) changes.created.splice(newTaskIdx, 1);

					changes.updated.push({ id: oldId, changes: {}, task: newTask });
				}
			}
		}

		if (
			changes.created.length === 0 &&
			changes.updated.length === 0 &&
			changes.deleted.length === 0
		) {
			return null;
		}

		return changes;
	}
}
