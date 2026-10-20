/**
 * 编辑任务命令：打开光标所在任务行的编辑弹窗（与 Tasks 插件的 "Create or edit Task" 同类，仅编辑）。
 * 光标不在任务行上时命令不可用（命令面板里不出现），可由用户经 Commander 等插件加入编辑器右键菜单。
 */

import { Notice, type Editor, type MarkdownFileInfo, type MarkdownView } from 'obsidian';
import type GanttCalendarPlugin from '../../main';
import { parseSingleTaskLine } from '../tasks/taskParser/main';
import type { TaskFormatType } from '../tasks/taskSerializerSymbols';
import { openEditTaskModal } from '../ui/modals/TaskFormModal';
import { Logger } from '../utils/logger';
import { i18n } from '../i18n/i18n';

export function registerEditTaskCommand(plugin: GanttCalendarPlugin): void {
	plugin.addCommand({
		id: 'edit-task',
		name: i18n.t('commands.editTask'),
		editorCheckCallback: (checking: boolean, editor: Editor, ctx: MarkdownView | MarkdownFileInfo): boolean => {
			const file = ctx.file;
			if (!file) return false;

			const lineIndex = editor.getCursor().line;
			const formats = (plugin.settings.enabledTaskFormats || ['tasks']) as TaskFormatType[];
			const task = parseSingleTaskLine(
				editor.getLine(lineIndex),
				file.path,
				file.basename,
				lineIndex + 1, // GCTask 行号从 1 起
				formats,
				plugin.settings.globalTaskFilter,
			);
			if (!task) return false;
			if (checking) return true;

			openEditTaskModal(plugin.app, task, formats, () => {
				plugin.taskCache.refreshFile(file.path)
					.then(() => plugin.refreshCalendarViews())
					.catch((error) => {
						Logger.error('editTaskCommand', 'Refresh after edit failed', error);
						new Notice(i18n.t('modals.editTask.error'));
					});
			}, true);
			return true;
		},
	});
}
