/**
 * 任务悬浮卡片内容构建（框架无关纯函数）
 *
 * React TooltipProvider 与命令式 TooltipManager 共用，
 * 保证两端分组顺序与字段永不漂移：时间 → 优先级 → 标签 → 元数据 → 文件位置。
 */

import type { GCTask } from '../../types';
import { formatDate } from '../../dateUtils/dateUtilsIndex';
import { i18n } from '../../i18n/i18n';

export interface TooltipPropRow {
	label: string;
	value: string;
	valueClass?: string;
	isOverdue?: boolean;
}

export interface TooltipSection {
	key: string;
	rows: TooltipPropRow[];
}

/** 优先级 emoji 映射（两端共用） */
const PRIORITY_ICONS: Record<string, string> = {
	highest: '🔺',
	high: '⏫',
	medium: '🔼',
	low: '🔽',
	lowest: '⏬',
};

/** 多级标签聚合后的一组：同一根标签下的所有子路径 */
export interface TagGroup {
	/** 根标签（不含 #），保留首次出现的大小写 */
	root: string;
	/** 根下各标签相对根的路径（如 `b`、`c/d`）；仅有根标签本身时为空 */
	children: string[];
}

/**
 * 按根标签聚合多级标签：`#a #a/b #a/c/d #e` → a{b, c/d}、e
 * 大小写不敏感去重（重复的 `#task #task` 只留一个），保持首次出现顺序
 */
export function groupTagsByRoot(tags: readonly string[]): TagGroup[] {
	const groups = new Map<string, TagGroup>();
	const seen = new Set<string>();
	for (const tag of tags) {
		const key = tag.toLowerCase();
		if (!tag || seen.has(key)) continue;
		seen.add(key);
		const slash = tag.indexOf('/');
		const root = slash < 0 ? tag : tag.slice(0, slash);
		const rest = slash < 0 ? '' : tag.slice(slash + 1);
		let group = groups.get(root.toLowerCase());
		if (!group) {
			group = { root, children: [] };
			groups.set(root.toLowerCase(), group);
		}
		if (rest) group.children.push(rest);
	}
	return Array.from(groups.values());
}

export function buildTooltipSections(task: GCTask): TooltipSection[] {
	const sections: TooltipSection[] = [];

	const timeRows: TooltipPropRow[] = [];
	const pushTime = (date: Date | undefined, label: string, precision?: 'day' | 'time') => {
		if (!date) return;
		timeRows.push({ label, value: formatDate(date, precision === 'time' ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd') });
	};
	pushTime(task.createdDate, i18n.t('taskCard.created'), task.datePrecision?.createdDate);
	pushTime(task.startDate, i18n.t('taskCard.start'), task.datePrecision?.startDate);
	pushTime(task.scheduledDate, i18n.t('taskCard.scheduled'), task.datePrecision?.scheduledDate);
	if (task.dueDate) {
		timeRows.push({
			label: i18n.t('taskCard.due'),
			value: formatDate(task.dueDate, task.datePrecision?.dueDate === 'time' ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd'),
			isOverdue: task.dueDate < new Date() && !task.completed,
		});
	}
	pushTime(task.cancelledDate, i18n.t('taskCard.cancelled'), task.datePrecision?.cancelledDate);
	pushTime(task.completionDate, i18n.t('taskCard.done'), task.datePrecision?.completionDate);
	if (task.repeat) timeRows.push({ label: i18n.t('taskCard.repeat'), value: task.repeat });
	if (timeRows.length > 0) sections.push({ key: 'time', rows: timeRows });

	if (task.priority && task.priority !== 'normal') {
		sections.push({
			key: 'priority',
			rows: [{
				label: i18n.t('taskCard.priority'),
				value: `${PRIORITY_ICONS[task.priority] || ''} ${i18n.t(`common.priority.${task.priority}`)}`,
				valueClass: `priority-${task.priority}`,
			}],
		});
	}

	if (task.tags && task.tags.length > 0) sections.push({ key: 'tags', rows: [] });

	if (task.metadataFields && task.metadataFields.length > 0) {
		sections.push({
			key: 'metadata',
			rows: task.metadataFields.map((f) => ({ label: f.key, value: f.value || i18n.t('taskCard.emptyValue') })),
		});
	}

	sections.push({
		key: 'file',
		rows: [{ label: i18n.t('taskCard.fileLocation'), value: `${task.fileName}:${task.lineNumber}` }],
	});

	return sections;
}
