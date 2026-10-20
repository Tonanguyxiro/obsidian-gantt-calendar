/**
 * 编辑任务命令：打开光标所在任务行的编辑弹窗（与 Tasks 插件的 "Create or edit Task" 同类，仅编辑）。
 * 命令面板里只要在编辑器内就能看到它（不依赖光标所在行），光标不在任务行上时给出提示；
 * 可由用户经 Commander 等插件加入编辑器右键菜单。
 */

import { Notice, type Editor, type MarkdownFileInfo, type MarkdownView } from 'obsidian';
import type GanttCalendarPlugin from '../../main';
import { parseSingleTaskLine } from '../tasks/taskParser/main';
import { parseTaskLine } from '../tasks/taskParser/step1';
import type { TaskFormatType } from '../tasks/taskSerializerSymbols';
import { openEditTaskModal } from '../ui/modals/TaskFormModal';
import { Logger } from '../utils/logger';
import { i18n } from '../i18n/i18n';

export function registerEditTaskCommand(plugin: GanttCalendarPlugin): void {
	plugin.addCommand({
		id: 'edit-task',
		name: i18n.t('commands.editTask'),
		editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo): void => {
			const file = ctx.file;
			if (!file) return;

			const lineIndex = editor.getCursor().line;
			const formats = (plugin.settings.enabledTaskFormats || ['tasks']) as TaskFormatType[];
			const filter = plugin.settings.globalTaskFilter;
			const parse = (line: string, globalFilter?: string) =>
				parseSingleTaskLine(line, file.path, file.basename, lineIndex + 1, formats, globalFilter); // GCTask 行号从 1 起

			let line = editor.getLine(lineIndex);
			let task = parse(line, filter);

			// 是复选框任务行但没有全局筛选符：本插件不会管理它。与 Tasks 插件一致，编辑即纳入管理——补上筛选符再打开
			if (!task && filter) {
				const match = parseTaskLine(line);
				if (match && parse(line)) {
					const at = line.lastIndexOf(match.content);
					line = `${line.slice(0, at)}${filter.trim()} ${line.slice(at)}`;
					editor.setLine(lineIndex, line);
					task = parse(line, filter);
				}
			}

			if (!task) {
				new Notice(i18n.t('commands.editTaskNotATask'));
				return;
			}

			openEditTaskModal(plugin.app, task, formats, () => {
				plugin.taskCache.refreshFile(file.path)
					.then(() => plugin.refreshCalendarViews())
					.catch((error) => {
						Logger.error('editTaskCommand', 'Refresh after edit failed', error);
						new Notice(i18n.t('modals.editTask.error'));
					});
			}, true);
		},
	});
}
