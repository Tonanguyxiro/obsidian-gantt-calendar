import { App, Notice, TFile } from 'obsidian';
import type { GCTask } from '../types';
import type { TaskUpdates } from './taskSerializer';
import { refreshTaskView, updateTaskProperties, withFileLock } from './taskUpdater';
import { Logger } from '../utils/logger';
import { i18n } from '../i18n/i18n';

/** 撤销按钮可挂载的 Notice 最小结构。 */
export interface UndoNotice {
	noticeEl: HTMLElement;
	hide?: () => void;
}

export type UndoNoticeFactory = (message: string, timeout?: number) => UndoNotice;
export type UndoButtonFactory = () => HTMLButtonElement;

/** Node 测试环境下没有 document；生产环境仍创建真实按钮。 */
function createDefaultUndoButton(): HTMLButtonElement {
	if (typeof document === 'undefined') {
		return {} as unknown as HTMLButtonElement;
	}
	return document.createElement('button');
}

type TaskUndoSnapshot =
	| {
		type: 'properties';
		app: App;
		oldTask: GCTask;
		updates: TaskUpdates;
		enabledFormats: string[];
		onRefresh: () => void;
	}
	| {
		type: 'delete';
		app: App;
		filePath: string;
		lineIndex: number;
		line: string;
		onRefresh: () => void;
	};

/**
 * 任务操作撤销服务。
 *
 * 只保留最近一次可撤销操作：新操作会覆盖上一个快照；撤销开始时立即清空槽位，
 * 避免恢复本身失败后被重复触发。
 */
export class TaskUndoService {
	private snapshot: TaskUndoSnapshot | null = null;

	constructor(
		private readonly noticeFactory: UndoNoticeFactory = (message, timeout) => new Notice(message, timeout),
		private readonly buttonFactory: UndoButtonFactory = createDefaultUndoButton,
	) {}

	registerProperty(input: {
		app: App;
		oldTask: GCTask;
		updates: TaskUpdates;
		enabledFormats: string[];
		onRefresh: () => void;
	}, successMessage: string): void {
		this.snapshot = {
			type: 'properties',
			app: input.app,
			oldTask: { ...input.oldTask },
			updates: input.updates,
			enabledFormats: input.enabledFormats,
			onRefresh: input.onRefresh,
		};
		this.showUndoNotice(successMessage);
	}

	registerDeletedLine(input: {
		app: App;
		filePath: string;
		lineIndex: number;
		line: string;
		onRefresh: () => void;
	}, successMessage: string): void {
		this.snapshot = {
			type: 'delete',
			app: input.app,
			filePath: input.filePath,
			lineIndex: input.lineIndex,
			line: input.line,
			onRefresh: input.onRefresh,
		};
		this.showUndoNotice(successMessage);
	}

	/** 撤销最近一次操作；没有可撤销操作时返回 false。 */
	async undo(target: TaskUndoSnapshot | null = this.snapshot): Promise<boolean> {
		if (!target || this.snapshot !== target) return false;

		// 先清空槽位：恢复失败时不会再次触发同一条撤销。
		this.snapshot = null;

		try {
			if (target.type === 'properties') {
				await this.undoProperties(target);
			} else {
				await this.undoDeletedLine(target);
			}
			this.noticeFactory(i18n.t('contextMenu.commands.undoSuccess'), 5000);
			return true;
		} catch (error) {
			Logger.error('taskUndo', 'Failed to undo task operation:', error);
			this.noticeFactory(i18n.t('contextMenu.commands.undoFailed'), 8000);
			return false;
		}
	}

	private async undoProperties(snapshot: Extract<TaskUndoSnapshot, { type: 'properties' }>): Promise<void> {
		const { app, oldTask, updates, enabledFormats, onRefresh } = snapshot;
		const inverseUpdates = {} as TaskUpdates;
		const inverseRecord = inverseUpdates as Record<string, unknown>;
		const oldRecord = oldTask as unknown as Record<string, unknown>;

		for (const key of Object.keys(updates)) {
			inverseRecord[key] = oldRecord[key];
		}

		await updateTaskProperties(app, oldTask, inverseUpdates, enabledFormats);
		await refreshTaskView(app, oldTask.filePath);
		onRefresh();
	}

	private async undoDeletedLine(snapshot: Extract<TaskUndoSnapshot, { type: 'delete' }>): Promise<void> {
		const { app, filePath, lineIndex, line, onRefresh } = snapshot;
		const file = app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			throw new Error(`Cannot undo deleted task: file not found: ${filePath}`);
		}

		await withFileLock(filePath, async () => {
			const content = await app.vault.read(file);
			const lines = content.split('\n');
			const insertIndex = Math.max(0, Math.min(lineIndex, lines.length));
			lines.splice(insertIndex, 0, line);
			await app.vault.modify(file, lines.join('\n'));
		});

		await refreshTaskView(app, filePath);
		onRefresh();
	}

	private showUndoNotice(message: string): void {
		const snapshot = this.snapshot;
		const notice = this.noticeFactory(message, 8000);
		const button = this.buttonFactory();
		button.textContent = i18n.t('contextMenu.commands.undoAction');
		button.onclick = () => {
			notice.hide?.();
			void this.undo(snapshot);
		};
		notice.noticeEl.appendChild(button);
	}
}

/** 全局单槽撤销服务。 */
export const taskUndo = new TaskUndoService();
