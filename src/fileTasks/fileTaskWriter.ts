/**
 * File-based task 写回：拖拽甘特文件行后更新 frontmatter 起止属性
 */

import { Notice, TFile, type App } from 'obsidian';
import type { FileTask } from '../types';
import type { GanttCalendarSettings } from '../settings/types';
import { RegularExpressions } from '../utils/RegularExpressions';
import { formatDate } from '../dateUtils/dateUtilsIndex';
import { i18n } from '../i18n/i18n';
import { Logger } from '../utils/logger';

/** 保持原值格式：原值带时刻则保留原时刻（拖拽是按天的），否则只写日期 */
function formatLike(original: unknown, date: Date): string {
	const m = typeof original === 'string' ? original.trim().match(RegularExpressions.FileTask.dateValue) : null;
	if (m && m[4] !== undefined) {
		const sep = (original as string).includes('T') ? 'T' : ' ';
		return `${formatDate(date, 'yyyy-MM-dd')}${sep}${m[4].padStart(2, '0')}:${m[5]}`;
	}
	return formatDate(date, 'yyyy-MM-dd');
}

export async function writeFileTaskDates(
	app: App,
	fileTask: FileTask,
	start: Date,
	end: Date,
	settings: GanttCalendarSettings,
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(fileTask.filePath);
	if (!(file instanceof TFile)) return;
	const startProp = settings.fileTaskStartProperty || 'start';
	const endProp = settings.fileTaskEndProperty || 'end';
	try {
		await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			const originalStart = fm[startProp];
			const originalEnd = fm[endProp] ?? originalStart;
			fm[startProp] = formatLike(originalStart, start);
			fm[endProp] = formatLike(originalEnd, end);
		});
		// 日期原本来自任务推导时，拖动即把范围固定为笔记属性（此后以属性为准）
		const range = { start: formatDate(start, 'yyyy-MM-dd'), end: formatDate(end, 'yyyy-MM-dd') };
		new Notice(fileTask.dateSource === 'frontmatter'
			? i18n.t('gantt.timeUpdated', range)
			: i18n.t('fileTasks.datesPinned', range));
	} catch (error) {
		Logger.error('fileTaskWriter', 'Failed to update file task dates:', error);
		new Notice(i18n.t('gantt.updateFailed', { error: (error as Error).message }));
	}
}
