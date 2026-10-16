import { App, Notice } from 'obsidian';
import type { GCTask } from '../../types';
import { updateTaskProperties, refreshTaskView } from '../../tasks/taskUpdater';
import { taskUndo } from '../../tasks/taskUndo';
import { Logger } from '../../utils/logger';
import { i18n } from '../../i18n/i18n';

/**
 * 取消任务
 * 将任务的复选框设置为 [-]，并添加取消日期
 * 注意：[-] 是取消状态，[/] 是进行中状态
 * @param app Obsidian App 实例
 * @param task 要取消的任务
 * @param enabledFormats 启用的任务格式
 * @param onRefresh 刷新回调
 */
export async function cancelTask(
	app: App,
	task: GCTask,
	enabledFormats: string[],
	onRefresh: () => void
): Promise<void> {
	try {
		// 如果任务已经是取消状态，则不处理
		if (task.status === 'canceled' || task.cancelled) {
			new Notice(i18n.t('contextMenu.commands.cancel.alreadyCancelled'));
			return;
		}

		// 如果任务已完成，先询问是否要取消
		if (task.completed) {
			new Notice(i18n.t('contextMenu.commands.cancel.cannotCancelDone'));
			return;
		}

		// 更新任务状态：设置为取消，并添加取消日期
		// 使用 status: 'canceled' 会自动将复选框设置为 [-]
		const updates = {
			status: 'canceled' as const,
			cancelled: true,
			cancelledDate: new Date()
		};
		await updateTaskProperties(app, task, updates, enabledFormats);
		await refreshTaskView(app, task.filePath);

		taskUndo.registerProperty({
			app,
			oldTask: task,
			updates,
			enabledFormats,
			onRefresh,
		}, i18n.t('contextMenu.commands.cancelled'));
		onRefresh();
	} catch (error) {
		Logger.error('cancelTask', 'Failed to cancel task:', error);
		new Notice(i18n.t('contextMenu.commands.cancelFailed'));
	}
}
