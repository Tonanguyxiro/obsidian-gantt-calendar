import { App, Notice, TFile } from 'obsidian';
import type { GCTask } from '../../types';
import { refreshTaskView, withFileLock, getGlobalTaskFilter, locateTaskLine } from '../../tasks/taskUpdater';
import { taskUndo } from '../../tasks/taskUndo';
import { Logger } from '../../utils/logger';
import { i18n } from '../../i18n/i18n';
import { showConfirmDialog } from '../../ui/modals/ConfirmDialog';

/**
 * 删除任务
 * 删除前必须二次确认；写回前重读文件并重定位任务行，避免并发编辑时误删。
 * @param app Obsidian App 实例
 * @param task 要删除的任务
 * @param onRefresh 刷新回调
 */
export async function deleteTask(
	app: App,
	task: GCTask,
	onRefresh: () => void
): Promise<void> {
	try {
		const file = app.vault.getAbstractFileByPath(task.filePath);
		if (!(file instanceof TFile)) {
			new Notice(i18n.t('contextMenu.commands.deleteTask.fileNotFound'));
			return;
		}

		const confirmed = await showConfirmDialog(
			app,
			i18n.t('contextMenu.commands.deleteTask.confirmTitle'),
			i18n.t('contextMenu.commands.deleteTask.confirmMessage', {
				description: task.description || task.content,
			}),
			{
				confirmText: i18n.t('contextMenu.commands.deleteTask.confirmAction'),
				isDestructive: true,
			}
		);
		if (!confirmed) return;

		await withFileLock(task.filePath, async () => {
			// 锁内重读，防止确认期间或并发操作后基于旧内容删行
			const content = await app.vault.read(file);
			const lines = content.split('\n');
			const taskLineIndex = locateTaskLine(lines, task, getGlobalTaskFilter(app));

			if (taskLineIndex === -1) {
				new Notice(i18n.t('contextMenu.commands.deleteTask.taskNotFound'));
				return;
			}

			// 删除任务所在行，不保留空行；先保存原文用于撤销
			const deletedLine = lines[taskLineIndex];
			lines.splice(taskLineIndex, 1);
			await app.vault.modify(file, lines.join('\n'));

			// 删除行走的是行号删改，立即重建缓存，避免下方任务行号错位视图停留 1~2s
			await refreshTaskView(app, task.filePath);
			taskUndo.registerDeletedLine({
				app,
				filePath: task.filePath,
				lineIndex: taskLineIndex,
				line: deletedLine,
				onRefresh,
			}, i18n.t('contextMenu.commands.deleted'));
			onRefresh();
		});
	} catch (error) {
		Logger.error('deleteTask', 'Failed to delete task:', error);
		new Notice(i18n.t('contextMenu.commands.deleteFailed'));
	}
}