/**
 * File-based task 解析（纯函数）
 *
 * 一个笔记的 frontmatter 带起止属性（默认 start / end）即为 file-based task，
 * 与 Timeline for Bases 的数据模型一致；可选的项目属性（默认 project）
 * 通常是 folder note 的双链，用于甘特图分组。
 */

import type { FileTask, FileTaskProject, GCTask } from '../types';
import { RegularExpressions } from '../utils/RegularExpressions';
import { wikilinkDisplayText, splitLinkTarget } from '../utils/linkText';

/** 解析 frontmatter 日期值（"2026-06-18" / "2026-06-18T09:30" / Date） */
export function parseFileTaskDate(value: unknown): Date | undefined {
	if (value instanceof Date) return isNaN(value.getTime()) ? undefined : value;
	if (typeof value !== 'string') return undefined;
	const m = value.trim().match(RegularExpressions.FileTask.dateValue);
	if (!m) return undefined;
	const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0);
	return isNaN(d.getTime()) ? undefined : d;
}

/** 双链解析器：目标文本 → 文件（路径 + 文件名），解析不到返回 null */
export type LinkResolver = (linkpath: string) => { path: string; basename: string } | null;

/**
 * 解析项目属性：取第一个非空值；双链 [[target|alias]] 解析目标文件作分组键，
 * 显示别名或目标文件名（不显示原始 [[...]] 语法）；纯文本原样作分组键
 */
export function parseFileTaskProject(value: unknown, resolve: LinkResolver): FileTaskProject | undefined {
	const toText = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
	const raw = Array.isArray(value)
		? (value as unknown[]).map(toText).find((v) => v !== '') ?? ''
		: toText(value);
	if (!raw) return undefined;

	const linkRegex = new RegExp(RegularExpressions.Links.obsidianLinkRegex.source);
	const m = raw.match(linkRegex);
	if (!m) return { key: raw, label: raw };

	const target = m[1];
	const alias = m[2];
	const file = resolve(splitLinkTarget(target).path);
	if (file) {
		return { key: file.path, label: alias?.trim() || file.basename, linkPath: file.path };
	}
	return { key: target, label: wikilinkDisplayText(target, alias) };
}

export interface FileTaskPropertyNames {
	start: string;
	end: string;
	project: string;
}

/** 两种引入来源（可同时开启，结果取并集） */
export interface FileTaskSources {
	/** 带日期属性的文件（Timeline for Bases 式：不要求文件内有任务） */
	includeDated: boolean;
	/** 含任务的文件（无日期属性时用文件内任务的日期） */
	includeTaskFiles: boolean;
	/** 带日期属性来源的标签过滤（不含 #、小写；空数组 = 不限；任一命中即可，父标签匹配子标签） */
	requiredTags: string[];
}

/** 判定单个文件所需的上下文 */
export interface FileTaskFileContext {
	/** 文件的全部标签（frontmatter + 正文，可带或不带 #） */
	tags: string[];
	/** 文件内的任务（已经过全局筛选） */
	tasks: GCTask[];
	/** 是否为每日笔记 */
	isDailyNote: boolean;
	/** 含任务来源下排除每日笔记（否则每篇带任务的日记都会成为文件条） */
	excludeDailyNotes: boolean;
}

/** 标签设置文本 → 规范化标签列表（逗号/空白分隔，去 #，小写，去重） */
export function parseRequiredTags(text: string): string[] {
	return Array.from(new Set(
		text.split(RegularExpressions.FileTask.tagListSeparator)
			.map((t) => t.trim().replace(RegularExpressions.FileTask.leadingHash, '').toLowerCase())
			.filter(Boolean),
	));
}

/** 文件标签是否命中任一要求标签（不区分大小写；#project 命中 #project/alpha） */
export function matchesRequiredTags(fileTags: string[], required: string[]): boolean {
	if (required.length === 0) return true;
	const tags = fileTags.map((t) => t.replace(RegularExpressions.FileTask.leadingHash, '').toLowerCase());
	return required.some((r) => tags.some((t) => t === r || t.startsWith(`${r}/`)));
}

function validDate(d: Date | undefined): d is Date {
	return !!d && !isNaN(d.getTime());
}

/**
 * 由文件内任务推导时间范围：取未取消任务的 🛫/⏳/📅 中最早与最晚日期
 * （创建/完成日期不代表计划，不参与）；没有任何可用日期返回 null
 */
export function taskDateRange(tasks: GCTask[]): { start: Date; end: Date } | null {
	let start: Date | undefined;
	let end: Date | undefined;
	for (const t of tasks) {
		if (t.cancelled) continue;
		for (const d of [t.startDate, t.scheduledDate, t.dueDate]) {
			if (!validDate(d)) continue;
			if (!start || d < start) start = d;
			if (!end || d > end) end = d;
		}
	}
	return start && end ? { start: new Date(start), end: new Date(end) } : null;
}

/**
 * 判定并构建 file-based task（两种来源取并集）：
 * - 带日期属性来源：frontmatter 有开始或结束属性，且命中标签过滤
 * - 含任务来源：文件内有任务（可排除每日笔记）；缺失的起止用任务日期范围补齐
 * 只有一端时按单日；结束早于开始时钳到开始日；仍无日期则不引入。
 */
export function buildFileTask(
	file: { path: string; basename: string },
	frontmatter: Record<string, unknown> | undefined,
	props: FileTaskPropertyNames,
	resolve: LinkResolver,
	sources: FileTaskSources,
	ctx: FileTaskFileContext,
): FileTask | null {
	const fmStart = frontmatter ? parseFileTaskDate(frontmatter[props.start]) : undefined;
	const fmEnd = frontmatter ? parseFileTaskDate(frontmatter[props.end]) : undefined;
	const hasFmDate = !!(fmStart || fmEnd);

	const viaDated = sources.includeDated && hasFmDate && matchesRequiredTags(ctx.tags, sources.requiredTags);
	const viaTasks = sources.includeTaskFiles && ctx.tasks.length > 0 && !(ctx.excludeDailyNotes && ctx.isDailyNote);
	if (!viaDated && !viaTasks) return null;

	const range = viaTasks ? taskDateRange(ctx.tasks) : null;
	const start = fmStart ?? range?.start ?? fmEnd;
	let end = fmEnd ?? range?.end ?? fmStart;
	if (!start || !end) return null;
	if (end < start) end = start;

	const fromTasks = (!fmStart && !!range) || (!fmEnd && !!range);
	const dateSource: FileTask['dateSource'] = !fromTasks ? 'frontmatter' : hasFmDate ? 'mixed' : 'tasks';
	const project = props.project && frontmatter ? parseFileTaskProject(frontmatter[props.project], resolve) : undefined;
	return { filePath: file.path, title: file.basename, start, end, project, dateSource };
}
