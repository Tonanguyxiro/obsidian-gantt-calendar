import type { IcsCalendarEvent } from '../../data-layer/ics/icsTask';
import { create } from 'zustand';
import type { GanttCalendarSettings } from '../../settings/types';
import { DEFAULT_SETTINGS } from '../../settings/constants';
import type {
	CalendarViewType,
	FileTask,
	GCTask,
	SortState,
	TagFilterState,
	StatusFilterState,
	FileFilterState,
} from '../../types';
import {
	DEFAULT_SORT_STATE,
	DEFAULT_TAG_FILTER_STATE,
	DEFAULT_STATUS_FILTER_STATE,
	DEFAULT_FILE_FILTER_STATE,
} from '../../types';

export type ViewScope = 'year' | 'month' | 'week' | 'day' | 'task' | 'gantt' | 'sidebar';

export type GanttScrollAction = 'left' | 'today' | 'right';

/** data.json 中的持久化形态：旧版本缺少后加的字段，按字段回退默认 */
export type PersistedViewFilters = Partial<Record<ViewScope, Partial<ViewFilterState>>>;

export interface ViewFilterState {
	status: StatusFilterState;
	tag: TagFilterState;
	sort: SortState;
	/** 文件筛选（Bases 语法） */
	file: FileFilterState;
	/** 任务查询（Tasks 语法，每行一条） */
	taskQuery: string;
}

interface CalendarStoreState {
	viewType: CalendarViewType;
	currentDate: Date;
	tasks: GCTask[];
	/** File-based task 全集（FileTaskIndex 推送；功能关闭时为空） */
	fileTasks: FileTask[];
	/** ICS 订阅事件（IcsService 推入；只读，仅内存） */
	icsEvents: IcsCalendarEvent[];
	/** 首扫是否已推入任务（whenReady 或事件回流任一路径）；false 时视图渲染骨架 */
	tasksReady: boolean;
	changedFilePath?: string;
	updateSeq: number;
	/** 插件设置不可变快照（由 main.ts / 视图生命周期 syncSettings 同步） */
	settings: GanttCalendarSettings;

	/** 每个视图作用域独立的筛选/排序状态（视图切换时保留） */
	viewFilters: Record<ViewScope, ViewFilterState>;

	/** 甘特图滚动请求（工具栏按钮 → GanttView 引擎） */
	ganttScroll: { seq: number; action: GanttScrollAction } | null;

	setViewType: (type: CalendarViewType) => void;
	setCurrentDate: (date: Date) => void;
	/** 数据层 TaskStore 通知时调用（防抖已由 TaskStore 处理） */
	notifyTasksUpdated: (tasks: GCTask[], filePath?: string) => void;
	setTasks: (tasks: GCTask[]) => void;
	setFileTasks: (fileTasks: FileTask[]) => void;
	setIcsEvents: (events: IcsCalendarEvent[]) => void;
	/** 同步最新设置快照（深拷贝隔离外部原地修改，并对未变化字段保持引用稳定） */
	syncSettings: (settings: GanttCalendarSettings) => void;
	/** 请求甘特图滚动（每次调用自增 seq，GanttView 订阅执行） */
	requestGanttScroll: (action: GanttScrollAction) => void;
	/** 插件启动时从 data.json 恢复持久化筛选（main.ts 在 loadSettings 后调用） */
	hydrateViewFilters: (filters?: PersistedViewFilters | null) => void;

	setStatusFilter: (scope: ViewScope, state: StatusFilterState) => void;
	setTagFilter: (scope: ViewScope, tag: TagFilterState) => void;
	setSort: (scope: ViewScope, sort: SortState) => void;
	setFileFilter: (scope: ViewScope, file: FileFilterState) => void;
	setTaskQuery: (scope: ViewScope, taskQuery: string) => void;
	applyFilter: (scope: ViewScope, status: StatusFilterState, tag: TagFilterState, sort: SortState) => void;
	/** 任务写回后触发一次顺带重渲染（数据最终由事件总线回流） */
	refreshTasks: () => void;
}

const defaultFilter = (): ViewFilterState => ({
	status: { selectedStatuses: [...DEFAULT_STATUS_FILTER_STATE.selectedStatuses] },
	tag: { selectedTags: [], operator: DEFAULT_TAG_FILTER_STATE.operator },
	sort: { ...DEFAULT_SORT_STATE },
	file: { ...DEFAULT_FILE_FILTER_STATE },
	taskQuery: '',
});

const buildInitialFilters = (): Record<ViewScope, ViewFilterState> => {
	const scopes: ViewScope[] = ['year', 'month', 'week', 'day', 'task', 'gantt', 'sidebar'];
	return scopes.reduce((acc, scope) => {
		acc[scope] = defaultFilter();
		return acc;
	}, {} as Record<ViewScope, ViewFilterState>);
};

/**
 * 按 scope 合并持久化的部分筛选数据到默认值上（结构演进容错：
 * 缺失的 scope / 字段用默认值补全）
 */
export function mergeViewFilters(
	partial?: PersistedViewFilters | null
): Record<ViewScope, ViewFilterState> {
	const base = buildInitialFilters();
	if (partial) {
		for (const scope of Object.keys(base) as ViewScope[]) {
			if (partial[scope]) base[scope] = { ...base[scope], ...partial[scope] };
		}
	}
	return base;
}

/**
 * 剔除「幽灵标签」：selectedTags 中在当前任务集里已不存在的标签。
 * 幽灵标签会形成隐形筛选（树里看不到勾选）：NOT 模式下匹配不到任何任务≈不过滤，
 * OR/AND 模式下匹配不到任何任务=全空。层级语义与 applyTagFilter 一致——
 * 父标签（如 work）在存在子标签（如 work/cyclops）时保留；大小写不敏感。
 * 任务集为空（如水合早于缓存就绪）时不做剔除，防误删真实筛选。
 * 无变化时返回原引用，避免触发订阅写回。
 */
export function pruneTagFilters(
	viewFilters: Record<ViewScope, ViewFilterState>,
	tasks: GCTask[]
): Record<ViewScope, ViewFilterState> {
	if (tasks.length === 0) return viewFilters;
	const tagSet = new Set<string>();
	for (const task of tasks) {
		for (const tag of task.tags || []) tagSet.add(tag.toLowerCase());
	}

	let changed = false;
	const next: Record<ViewScope, ViewFilterState> = { ...viewFilters };
	for (const scope of Object.keys(next) as ViewScope[]) {
		const { tag } = next[scope];
		if (tag.selectedTags.length === 0) continue;
		const kept = tag.selectedTags.filter((sel) => {
			const s = sel.toLowerCase();
			if (tagSet.has(s)) return true;
			return Array.from(tagSet).some((t) => t.startsWith(s + '/'));
		});
		if (kept.length !== tag.selectedTags.length) {
			changed = true;
			next[scope] = { ...next[scope], tag: { ...tag, selectedTags: kept } };
		}
	}
	return changed ? next : viewFilters;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
	if (typeof val !== 'object' || val === null || Array.isArray(val)) return false;
	const proto = Object.getPrototypeOf(val) as unknown;
	return proto === Object.prototype || proto === null;
}

function deepClone<T>(value: T): T {
	if (value === null || typeof value !== 'object') return value;
	if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
	if (Array.isArray(value)) {
		return (value as unknown[]).map((item) => deepClone(item)) as unknown as T;
	}
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value)) {
			out[key] = deepClone(value[key]);
		}
		return out as T;
	}
	return value;
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
		return false;
	}
	if (a instanceof Date && b instanceof Date) {
		return a.getTime() === b.getTime();
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) return false;
		}
		return true;
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const keysA = Object.keys(a);
		const keysB = Object.keys(b);
		if (keysA.length !== keysB.length) return false;
		for (const key of keysA) {
			if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
			if (!deepEqual(a[key], b[key])) return false;
		}
		return true;
	}
	return false;
}

function normalizeSettings(input?: Partial<GanttCalendarSettings> | null): GanttCalendarSettings {
	const base = deepClone(DEFAULT_SETTINGS);
	if (!input) return base;
	const merged: Record<string, unknown> = { ...base };
	for (const key of Object.keys(input)) {
		const val = (input as Record<string, unknown>)[key];
		if (val !== undefined) {
			merged[key] = deepClone(val);
		}
	}
	if (input.fileTaskViews) {
		merged.fileTaskViews = {
			...base.fileTaskViews,
			...Object.fromEntries(
				Object.entries(input.fileTaskViews).map(([k, v]) => [
					k,
					{
						...base.fileTaskViews[k as keyof typeof base.fileTaskViews],
						...deepClone(v),
					},
				])
			),
		};
	}
	return merged as unknown as GanttCalendarSettings;
}

function reconcileValue<T>(prev: T, next: T): T {
	if (Object.is(prev, next)) return prev;
	if (prev === null || next === null || typeof prev !== 'object' || typeof next !== 'object') {
		return next;
	}
	if (prev instanceof Date && next instanceof Date) {
		return prev.getTime() === next.getTime() ? prev : next;
	}
	if (Array.isArray(prev) && Array.isArray(next)) {
		if (deepEqual(prev, next)) return prev;
		const prevArr = prev as unknown[];
		const nextArr = next as unknown[];
		return nextArr.map((item, i) => (i < prevArr.length ? reconcileValue(prevArr[i], item) : item)) as unknown as T;
	}
	if (isPlainObject(prev) && isPlainObject(next)) {
		const prevKeys = Object.keys(prev);
		const nextKeys = Object.keys(next);
		let changed = prevKeys.length !== nextKeys.length;
		const out: Record<string, unknown> = {};
		for (const key of nextKeys) {
			const hadKey = Object.prototype.hasOwnProperty.call(prev, key);
			const nextVal = hadKey ? reconcileValue(prev[key], next[key]) : next[key];
			if (!hadKey || !Object.is(nextVal, prev[key])) {
				changed = true;
			}
			out[key] = nextVal;
		}
		if (!changed) return prev;
		return out as T;
	}
	return next;
}

export const useCalendarStore = create<CalendarStoreState>((set) => ({
	viewType: 'year',
	currentDate: new Date(),
	tasks: [],
	fileTasks: [],
	icsEvents: [],
	tasksReady: false,
	changedFilePath: undefined,
	updateSeq: 0,
	viewFilters: buildInitialFilters(),
	settings: deepClone(DEFAULT_SETTINGS),
	ganttScroll: null,

	setViewType: (type) => set({ viewType: type }),
	setCurrentDate: (date) => set({ currentDate: new Date(date) }),
	notifyTasksUpdated: (tasks, filePath) =>
		set((s) => {
			// 同一次 TaskStore 防抖冲刷会被主视图和侧栏两个订阅者各转发一次，
			// 第二次传入的数组引用相同（L1 缓存）——直接跳过，
			// 避免 updateSeq 重复自增引发二次重渲染
			if (tasks === s.tasks && filePath === s.changedFilePath) return s;
			// 任务集刷新时同步剔除失效标签（幽灵标签隐形筛选的根治）
			return {
				tasks,
				tasksReady: true,
				changedFilePath: filePath,
				updateSeq: s.updateSeq + 1,
				viewFilters: pruneTagFilters(s.viewFilters, tasks),
			};
		}),
	setTasks: (tasks) =>
		set((s) => ({
			tasks,
			tasksReady: true,
			viewFilters: pruneTagFilters(s.viewFilters, tasks),
		})),
	setFileTasks: (fileTasks) => set({ fileTasks }),
	setIcsEvents: (icsEvents) => set({ icsEvents }),
	syncSettings: (settings) =>
		set((s) => {
			const normalized = normalizeSettings(settings);
			const reconciled = reconcileValue(s.settings, normalized);
			if (reconciled === s.settings) return s;
			return { settings: reconciled };
		}),
	requestGanttScroll: (action) =>
		set((s) => ({ ganttScroll: { seq: (s.ganttScroll?.seq ?? 0) + 1, action } })),
	/** 任务写回后触发一次顺带重渲染（数据最终由事件总线回流） */
	refreshTasks: () => set((s) => ({ updateSeq: s.updateSeq + 1 })),

	hydrateViewFilters: (filters) =>
		set((s) => ({
			// 水合时按当前任务集剔除幽灵标签；任务集未就绪（空）时不动，待任务到来再剔除
			viewFilters: pruneTagFilters(mergeViewFilters(filters), s.tasks),
		})),

	setStatusFilter: (scope, status) =>
		set((s) => {
			const vf = { ...s.viewFilters, [scope]: { ...s.viewFilters[scope], status } };
			return { viewFilters: vf };
		}),
	setTagFilter: (scope, tag) =>
		set((s) => {
			const vf = { ...s.viewFilters, [scope]: { ...s.viewFilters[scope], tag } };
			return { viewFilters: vf };
		}),
	setSort: (scope, sort) =>
		set((s) => {
			const vf = { ...s.viewFilters, [scope]: { ...s.viewFilters[scope], sort } };
			return { viewFilters: vf };
		}),
	setFileFilter: (scope, file) =>
		set((s) => ({ viewFilters: { ...s.viewFilters, [scope]: { ...s.viewFilters[scope], file } } })),
	setTaskQuery: (scope, taskQuery) =>
		set((s) => ({ viewFilters: { ...s.viewFilters, [scope]: { ...s.viewFilters[scope], taskQuery } } })),
	applyFilter: (scope, status, tag, sort) =>
		set((s) => {
			const vf = { ...s.viewFilters, [scope]: { ...s.viewFilters[scope], status, tag, sort } };
			return { viewFilters: vf };
		}),
}));

/**
 * 选择器：获取某视图作用域的筛选状态
 */
export const selectViewFilter = (state: CalendarStoreState, scope: ViewScope): ViewFilterState =>
	state.viewFilters[scope] || defaultFilter();

