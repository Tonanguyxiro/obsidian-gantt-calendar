/**
 * StatusBarPresenter - 状态栏展示逻辑
 *
 * 将任务统计的取数、防抖与 DOM 写入隔离，避免 TaskStore 的
 * 高频更新直接放大为状态栏 DOM 操作。
 */
import type { GCTask } from '../types';

export interface StatusBarTextElement {
	setText(text: string): void;
}

export interface StatusBarTaskCounts {
	total: number;
	incomplete: number;
}

export interface StatusBarStatusParts {
	lastSync: string;
	syncStatus: string;
}

export interface StatusBarPresenterOptions {
	/** 状态栏防抖间隔，避免批量任务事件造成连续 DOM 更新 */
	debounceMs?: number;
}

export class StatusBarPresenter {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private lastText: string | null = null;
	private lastTasks: readonly GCTask[] | null = null;
	private lastCounts: StatusBarTaskCounts = { total: 0, incomplete: 0 };

	constructor(
		private readonly element: StatusBarTextElement,
		private readonly getTasks: () => readonly GCTask[],
		private readonly getStatusParts: () => StatusBarStatusParts,
		options: StatusBarPresenterOptions = {},
	) {
		this.debounceMs = options.debounceMs ?? 300;
	}

	readonly debounceMs: number;

	scheduleUpdate(): void {
		if (this.timer !== null) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.renderNow();
		}, this.debounceMs);
	}

	cancelScheduledUpdate(): void {
		if (this.timer === null) return;
		clearTimeout(this.timer);
		this.timer = null;
	}

	renderNow(): void {
		this.cancelScheduledUpdate();

		const tasks = this.getTasks();
		// 数据引用未变化时复用上一次计数，避免大数组重复扫描。
		if (tasks !== this.lastTasks) {
			this.lastTasks = tasks;
			this.lastCounts = {
				total: tasks.length,
				incomplete: tasks.filter(task => !task.completed).length,
			};
		}

		const { lastSync, syncStatus } = this.getStatusParts();
		const text = ` ${this.lastCounts.incomplete}/${this.lastCounts.total} | ${lastSync} | ${syncStatus}`;
		if (text === this.lastText) return;

		this.element.setText(text);
		this.lastText = text;
	}
}