/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { App } from 'obsidian';
import { TaskRepository } from '../src/data-layer/TaskRepository';
import { EventBus } from '../src/data-layer/EventBus';
import type { IDataSource } from '../src/data-layer/IDataSource';
import type { DataSourceChanges, DataSourceConfig, SyncStatus, TaskChanges } from '../src/data-layer/types';
import { TaskStore } from '../src/TaskStore';
import type { GCTask, IPluginContext } from '../src/types';
import { PluginContext } from '../src/ui/pluginContext';
import { useCalendarStore } from '../src/ui/store/calendarStore';
import { useViewTasks } from '../src/ui/utils/useViewTasks';

class StubSource implements IDataSource {
	readonly sourceId = 'stub';
	readonly sourceName = 'Stub';
	readonly isReadOnly = false;
	private handler?: (changes: DataSourceChanges, opts?: { initial?: boolean }) => void | Promise<void>;

	async initialize(_config: DataSourceConfig): Promise<void> {}
	async getTasks(): Promise<GCTask[]> { return []; }
	onChange(handler: (changes: DataSourceChanges, opts?: { initial?: boolean }) => void | Promise<void>): void {
		this.handler = handler;
	}
	async emit(changes: DataSourceChanges, opts?: { initial?: boolean }): Promise<void> {
		await this.handler?.(changes, opts);
	}
	async createTask(_task: GCTask): Promise<string> { return ''; }
	async updateTask(_taskId: string, _changes: TaskChanges): Promise<void> {}
	async deleteTask(_taskId: string): Promise<void> {}
	async getSyncStatus(): Promise<SyncStatus> {
		return { syncDirection: 'import-only', conflictResolution: 'local-win' };
	}
	destroy(): void {}
}

function makeTask(
	filePath: string,
	lineNumber: number,
	overrides: Partial<GCTask> = {}
): GCTask {
	return {
		filePath,
		fileName: filePath.split('/').pop()?.replace(/\.md$/, '') || '',
		lineNumber,
		content: `Task ${filePath}:${lineNumber}`,
		description: `Task ${filePath}:${lineNumber}`,
		completed: false,
		priority: 'normal',
		status: 'todo',
		...overrides,
	};
}

describe('TaskRepository 日期桶二级索引与 getTasksByDateRange', () => {
	let bus: EventBus;
	let repo: TaskRepository;
	let source: StubSource;

	beforeEach(() => {
		bus = new EventBus();
		repo = new TaskRepository(bus);
		source = new StubSource();
		repo.registerDataSource(source);
	});

	afterEach(() => {
		repo.clear();
	});

	it('索引全部 6 类日期字段且支持多日跨度（<=62天）与长跨度（>62天）', async () => {
		const tDue = makeTask('a.md', 1, { dueDate: new Date(2026, 9, 15) });
		const tCreated = makeTask('a.md', 2, { createdDate: new Date(2026, 9, 10) });
		const tScheduled = makeTask('a.md', 3, { scheduledDate: new Date(2026, 9, 12) });
		const tCompleted = makeTask('a.md', 4, { completionDate: new Date(2026, 9, 18), completed: true });
		const tCancelled = makeTask('a.md', 5, { cancelledDate: new Date(2026, 9, 20), cancelled: true });
		const tShortSpan = makeTask('span.md', 1, {
			startDate: new Date(2026, 9, 1),
			dueDate: new Date(2026, 9, 30),
		});
		const tExact62 = makeTask('span.md', 2, {
			startDate: new Date(2026, 8, 1), // Sep 1
			dueDate: new Date(2026, 10, 2), // Nov 2 (62 days span)
		});
		const tLongSpan = makeTask('long.md', 1, {
			startDate: new Date(2026, 0, 1),
			dueDate: new Date(2026, 11, 31),
		});
		const tRecurring = makeTask('rec.md', 1, {
			dueDate: new Date(2026, 0, 5),
			repeat: 'every week',
		});
		const tDateless = makeTask('dateless.md', 1);

		await source.emit({
			sourceId: 'stub',
			created: [
				tDue,
				tCreated,
				tScheduled,
				tCompleted,
				tCancelled,
				tShortSpan,
				tExact62,
				tLongSpan,
				tRecurring,
				tDateless,
			],
			updated: [],
			deleted: [],
		});

		// 查询 10 月中旬单日（Oct 15）：命中 Oct 15 dueDate + Oct 1-30 span + 62天 span + >62天 longSpan + recurring 模板
		const oct15 = repo.getTasksByDateRange(new Date(2026, 9, 15), new Date(2026, 9, 15));
		const oct15Keys = oct15.map((t) => `${t.filePath}:${t.lineNumber}`).sort();
		expect(oct15Keys).toEqual(['a.md:1', 'long.md:1', 'rec.md:1', 'span.md:1', 'span.md:2']);

		// 不应包含无日期任务或只在其他日期的任务
		expect(oct15Keys).not.toContain('dateless.md:1');
		expect(oct15Keys).not.toContain('a.md:2');

		// 查询 Oct 10-20：覆盖 created, scheduled, due, completion, cancelled
		const octMid = repo.getTasksByDateRange(new Date(2026, 9, 10), new Date(2026, 9, 20));
		const octMidKeys = octMid.map((t) => `${t.filePath}:${t.lineNumber}`).sort();
		expect(octMidKeys).toEqual([
			'a.md:1',
			'a.md:2',
			'a.md:3',
			'a.md:4',
			'a.md:5',
			'long.md:1',
			'rec.md:1',
			'span.md:1',
			'span.md:2',
		]);

		// 显式传入 dateField 时保持向后兼容：精确按该字段过滤
		const dueOnly = repo.getTasksByDateRange(new Date(2026, 9, 10), new Date(2026, 9, 20), 'dueDate');
		expect(dueOnly.map((t) => `${t.filePath}:${t.lineNumber}`)).toEqual(['a.md:1']);
	});

	it('日历查询模式不扫描全量 taskCache', async () => {
		const tasks: GCTask[] = [];
		for (let i = 1; i <= 100; i++) {
			tasks.push(makeTask('bulk.md', i, { dueDate: new Date(2026, 0, (i % 28) + 1) }));
		}
		tasks.push(makeTask('target.md', 1, { dueDate: new Date(2026, 9, 25) }));

		await source.emit({ sourceId: 'stub', created: tasks, updated: [], deleted: [] });

		const internalCache = (repo as unknown as { taskCache: Map<string, GCTask> }).taskCache;
		const valuesSpy = jest.spyOn(internalCache, 'values');

		const matched = repo.getTasksByDateRange(new Date(2026, 9, 24), new Date(2026, 9, 26));
		expect(matched.map((t) => `${t.filePath}:${t.lineNumber}`)).toEqual(['target.md:1']);
		expect(valuesSpy).not.toHaveBeenCalled();

		valuesSpy.mockRestore();
	});

	it('更新、删除、行号漂移、deletedFilePaths 与 clear 均精确维护二级索引', async () => {
		const t1 = makeTask('note.md', 1, { dueDate: new Date(2026, 9, 10), repeat: 'every day' });
		const t2 = makeTask('note.md', 2, {
			startDate: new Date(2026, 0, 1),
			dueDate: new Date(2026, 11, 31),
		});
		await source.emit({ sourceId: 'stub', created: [t1, t2], updated: [], deleted: [] });

		// 更新 t1：日期改到 Oct 20 并移除 repeat
		const t1Updated = makeTask('note.md', 3, { dueDate: new Date(2026, 9, 20) });
		await source.emit({
			sourceId: 'stub',
			created: [],
			updated: [{ id: 'note.md:1', changes: {}, task: t1Updated }],
			deleted: [],
		});

		// 旧日期 Oct 10 不再命中 t1Updated（且不再在 recurringTaskIds 里）
		const oct10 = repo.getTasksByDateRange(new Date(2026, 9, 10), new Date(2026, 9, 10));
		expect(oct10.map((t) => `${t.filePath}:${t.lineNumber}`)).toEqual(['note.md:2']);

		// 新日期 Oct 20 命中 t1Updated
		const oct20 = repo.getTasksByDateRange(new Date(2026, 9, 20), new Date(2026, 9, 20));
		expect(oct20.map((t) => `${t.filePath}:${t.lineNumber}`).sort()).toEqual(['note.md:2', 'note.md:3']);

		// deletedFilePaths 彻底清理该文件的桶、longSpanIds、recurringTaskIds
		await source.emit({
			sourceId: 'stub',
			created: [],
			updated: [],
			deleted: [],
			deletedFilePaths: ['note.md'],
		});
		expect(repo.getTasksByDateRange(new Date(2026, 9, 20), new Date(2026, 9, 20))).toEqual([]);

		// clear() 清空所有索引
		await source.emit({
			sourceId: 'stub',
			created: [makeTask('x.md', 1, { dueDate: new Date(2026, 9, 1), repeat: 'every week' })],
			updated: [],
			deleted: [],
		});
		expect(repo.getTasksByDateRange(new Date(2026, 9, 1), new Date(2026, 9, 1))).toHaveLength(1);
		repo.clear();
		expect(repo.getTasksByDateRange(new Date(2026, 9, 1), new Date(2026, 9, 1))).toEqual([]);
	});
});

describe('TaskStore.getTasksByDateRange 缓存与失效', () => {
	it('同一日期范围命中缓存，变更/invalidateCache 后自动失效', async () => {
		const files: Record<string, string> = {
			'tasks.md': '- [ ] Alpha 📅 2026-10-15\n- [ ] Beta 📅 2026-11-20',
		};
		const app = {
			vault: {
				getMarkdownFiles: () => [{ path: 'tasks.md', basename: 'tasks', extension: 'md', stat: { mtime: 1, ctime: 1, size: 10 } }],
				getAbstractFileByPath: (p: string) =>
					files[p] !== undefined ? { path: p, basename: 'tasks', extension: 'md', stat: { mtime: 1, ctime: 1, size: 10 } } : null,
				read: async (f: { path: string }) => files[f.path],
				on: () => ({}),
				offref: () => {},
			},
			metadataCache: {
				getFileCache: () => ({
					listItems: [
						{ position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 25, offset: 0 } } },
						{ position: { start: { line: 1, col: 0, offset: 0 }, end: { line: 1, col: 24, offset: 0 } } },
					],
				}),
				on: () => ({}),
				offref: () => {},
			},
		} as unknown as App;

		const store = new TaskStore(app);
		await store.initialize('');

		const repo = (store as unknown as { repository: TaskRepository }).repository;
		const repoSpy = jest.spyOn(repo, 'getTasksByDateRange');

		const r1 = store.getTasksByDateRange(new Date(2026, 9, 1), new Date(2026, 9, 31));
		const r2 = store.getTasksByDateRange(new Date(2026, 9, 1), new Date(2026, 9, 31));
		expect(r1).toBe(r2); // 同范围命中范围缓存，引用稳定
		expect(repoSpy).toHaveBeenCalledTimes(1);

		// notifyNow 使缓存失效
		store.notifyNow();
		store.getTasksByDateRange(new Date(2026, 9, 1), new Date(2026, 9, 31));
		expect(repoSpy).toHaveBeenCalledTimes(2);

		repoSpy.mockRestore();
		store.clear();
	});
});

describe('useViewTasks 日期范围查询与回退兼容', () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(window as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		useCalendarStore.setState({ tasks: [], updateSeq: 0 });
		container = document.body.appendChild(new DOMParser().parseFromString('<div></div>', 'text/html').body.firstElementChild as HTMLDivElement);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	it('传入 dateRange 且 taskCache.getTasksByDateRange 存在时按范围查询并响应 updateSeq', async () => {
		const octTask = makeTask('oct.md', 1, { scheduledDate: new Date(2026, 9, 19) });
		const janTask = makeTask('jan.md', 1, { dueDate: new Date(2026, 0, 5) });
		let rangeResult: GCTask[] = [octTask];
		const getTasksByDateRange = jest.fn(() => rangeResult);

		const plugin = {
			app: {} as IPluginContext['app'],
			settings: {} as IPluginContext['settings'],
			saveSettings: async () => {},
			refreshCalendarViews: () => {},
			taskCache: {
				getAllTasks: () => [octTask, janTask],
				getTasksByDateRange,
				refreshFile: async () => {},
				onUpdate: () => {},
				offUpdate: () => {},
				initialize: async () => {},
			},
		} as unknown as IPluginContext;

		let observed: GCTask[] = [];
		function Harness({ start, end }: { start: Date; end: Date }) {
			observed = useViewTasks('startDate', 'dueDate', 'dueDate', false, { start, end });
			return null;
		}

		// Store 里放全量任务（含 1 月任务），但 Hook 只走范围查询
		useCalendarStore.setState({ tasks: [octTask, janTask], updateSeq: 1 });

		await act(async () => {
			root.render(
				createElement(
					PluginContext.Provider,
					{ value: plugin },
					createElement(Harness, { start: new Date(2026, 9, 1), end: new Date(2026, 9, 31) })
				)
			);
		});

		expect(getTasksByDateRange).toHaveBeenCalledTimes(1);
		expect(observed).toHaveLength(1);
		expect(observed[0].filePath).toBe('oct.md');
		// applyScheduledFallback 仍对命中任务生效（⏳ 代理到 dueDate）
		expect(observed[0].dueDate).toEqual(new Date(2026, 9, 19));
		expect(observed[0].scheduledProxy).toBeDefined();

		// updateSeq 变更时重新查询范围
		const octTask2 = makeTask('oct.md', 2, { dueDate: new Date(2026, 9, 22) });
		rangeResult = [octTask, octTask2];
		await act(async () => {
			useCalendarStore.getState().refreshTasks();
		});

		expect(getTasksByDateRange).toHaveBeenCalledTimes(2);
		expect(observed).toHaveLength(2);
	});

	it('省略 dateRange 或 mock 缺少 getTasksByDateRange 时回退到 store.tasks', async () => {
		const t1 = makeTask('a.md', 1, { scheduledDate: new Date(2026, 9, 10) });
		const t2 = makeTask('b.md', 1, { dueDate: new Date(2026, 0, 5) });
		useCalendarStore.setState({ tasks: [t1, t2], updateSeq: 0 });

		// 场景 A：PluginContext 中 taskCache 没有 getTasksByDateRange
		const mockPluginWithoutRange = {
			app: {} as IPluginContext['app'],
			settings: {} as IPluginContext['settings'],
			saveSettings: async () => {},
			refreshCalendarViews: () => {},
			taskCache: {
				getAllTasks: () => [t1, t2],
				refreshFile: async () => {},
				onUpdate: () => {},
				offUpdate: () => {},
				initialize: async () => {},
			},
		} as unknown as IPluginContext;

		let observedA: GCTask[] = [];
		function HarnessWithRange() {
			observedA = useViewTasks('startDate', 'dueDate', 'dueDate', false, {
				start: new Date(2026, 9, 1),
				end: new Date(2026, 9, 31),
			});
			return null;
		}

		await act(async () => {
			root.render(
				createElement(PluginContext.Provider, { value: mockPluginWithoutRange }, createElement(HarnessWithRange))
			);
		});
		expect(observedA).toHaveLength(2);

		// 场景 B：完全无 PluginContext 且省略 dateRange
		let observedB: GCTask[] = [];
		function HarnessWithoutRange() {
			observedB = useViewTasks('startDate', 'dueDate', 'dueDate');
			return null;
		}

		await act(async () => {
			root.render(createElement(HarnessWithoutRange));
		});
		expect(observedB).toHaveLength(2);
	});
});
