/**
 * 任务子项解析与写回辅助（子任务 + bullet items）
 *
 * 规则：
 * 1. 子任务（subtasks）：只识别任务下方直接嵌套的一级复选框任务行（不要求携带全局筛选符），
 *    不包含二级及更深子任务。
 * 2. bullet items：识别任务下方的非任务列表项，支持多级纯文字缩进；
 *    子任务本身会被过滤掉，且任何子任务下方的缩进内容（含 bullet / 子子任务）一律不包含。
 */

import type { TaskBulletItem, TaskSubtask } from '../../types';
import { RegularExpressions } from '../../utils/RegularExpressions';
import { parseTaskLine } from './step1';
import { removeGlobalFilter } from './step2';
import { parseCheckboxStatus } from './step4';
import { extractTaskDescription, extractTicktick } from './utils';

export interface DataviewChildItemLike {
	line?: unknown;
	task?: unknown;
	status?: unknown;
	symbol?: unknown;
	text?: unknown;
	completed?: unknown;
	children?: Iterable<DataviewChildItemLike> | { array?: () => DataviewChildItemLike[]; values?: DataviewChildItemLike[] };
}

export interface ParsedTaskChildren {
	subtasks: TaskSubtask[];
	bulletItems: TaskBulletItem[];
}

export interface LineIndentInfo {
	quotePrefix: string;
	quoteDepth: number;
	wsIndent: string;
	indentWidth: number;
}

const TAB_WIDTH = 4;

/** 测量一行的引用前缀深度与列表缩进宽度（tab 按 4 列折算） */
export function measureLineIndent(line: string): LineIndentInfo {
	const match = line.match(RegularExpressions.blockquotePrefixRegex);
	const quotePrefix = match?.[1] ?? '';
	const wsIndent = match?.[2] ?? '';
	let quoteDepth = 0;
	for (let i = 0; i < quotePrefix.length; i++) {
		if (quotePrefix[i] === '>') quoteDepth++;
	}
	let indentWidth = 0;
	for (let i = 0; i < wsIndent.length; i++) {
		indentWidth += wsIndent[i] === '\t' ? TAB_WIDTH : 1;
	}
	return { quotePrefix, quoteDepth, wsIndent, indentWidth };
}

function isBlankOrQuoteOnly(line: string): boolean {
	return RegularExpressions.blankOrQuoteOnlyRegex.test(line);
}

function cleanSubtaskDescription(rawContent: string, globalTaskFilter?: string): string {
	const withoutFilter = removeGlobalFilter(rawContent, globalTaskFilter);
	const { contentWithoutTicktick } = extractTicktick(withoutFilter);
	const desc = extractTaskDescription(contentWithoutTicktick);
	return desc || withoutFilter.trim() || rawContent.trim();
}

/** 找到某任务行下方的连续子块范围 [start, end)（0-based 行索引） */
export function findTaskChildBlockEnd(lines: readonly string[], taskLineIndex: number): number {
	const parentLine = lines[taskLineIndex];
	if (parentLine === undefined) return taskLineIndex + 1;
	const parent = measureLineIndent(parentLine);
	let lastChildLine = taskLineIndex;

	for (let i = taskLineIndex + 1; i < lines.length; i++) {
		const line = lines[i];
		if (isBlankOrQuoteOnly(line)) {
			// 空行只有在其后仍紧跟更深缩进的同行引用子项时才属于子块
			continue;
		}
		const cur = measureLineIndent(line);
		if (cur.quoteDepth !== parent.quoteDepth || cur.indentWidth <= parent.indentWidth) {
			break;
		}
		lastChildLine = i;
	}

	return lastChildLine + 1;
}

/**
 * 从 Markdown 行数组中提取指定任务的一级子任务与多级 bullet items
 *
 * @param lines 文件全部行
 * @param taskLineIndex 任务行 0-based 索引
 * @param globalTaskFilter 全局筛选符（仅用于清理子任务展示文本，不用于过滤子任务）
 */
export function extractTaskChildrenFromLines(
	lines: readonly string[],
	taskLineIndex: number,
	globalTaskFilter?: string
): ParsedTaskChildren {
	const subtasks: TaskSubtask[] = [];
	const bulletItems: TaskBulletItem[] = [];

	const blockEnd = findTaskChildBlockEnd(lines, taskLineIndex);
	if (blockEnd <= taskLineIndex + 1) {
		return { subtasks, bulletItems };
	}

	let directChildIndent: number | null = null;
	let skippedSubtaskIndent: number | null = null;
	const bulletIndentStack: number[] = [];

	for (let i = taskLineIndex + 1; i < blockEnd; i++) {
		const line = lines[i];
		if (isBlankOrQuoteOnly(line)) continue;

		const cur = measureLineIndent(line);

		// 正在跳过某个子任务的子树：只要缩进仍大于该子任务就一律跳过
		if (skippedSubtaskIndent !== null) {
			if (cur.indentWidth > skippedSubtaskIndent) {
				continue;
			}
			skippedSubtaskIndent = null;
		}

		if (directChildIndent === null || cur.indentWidth < directChildIndent) {
			directChildIndent = cur.indentWidth;
		}

		const taskMatch = parseTaskLine(line);
		if (taskMatch) {
			// 无论层级，遇到子任务就屏蔽其整个子树（不包含子任务下的内容）
			skippedSubtaskIndent = cur.indentWidth;
			// 仅收集直接一级子任务
			if (cur.indentWidth === directChildIndent) {
				const { completed, cancelled, status } = parseCheckboxStatus(taskMatch.checkboxStatus);
				subtasks.push({
					lineNumber: i + 1,
					checkboxSymbol: taskMatch.checkboxStatus,
					completed,
					cancelled,
					status,
					description: cleanSubtaskDescription(taskMatch.content, globalTaskFilter),
					rawContent: taskMatch.content,
				});
			}
			continue;
		}

		const bulletMatch = line.match(RegularExpressions.bulletItemRegex);
		if (bulletMatch) {
			const marker = bulletMatch[2];
			const text = bulletMatch[3].trim();
			while (bulletIndentStack.length > 0 && bulletIndentStack[bulletIndentStack.length - 1] >= cur.indentWidth) {
				bulletIndentStack.pop();
			}
			const level = bulletIndentStack.length;
			bulletIndentStack.push(cur.indentWidth);

			bulletItems.push({
				lineNumber: i + 1,
				level,
				marker,
				text,
			});
		}
	}

	return { subtasks, bulletItems };
}

function toChildArray(
	collection: DataviewChildItemLike['children'] | undefined | null
): DataviewChildItemLike[] {
	if (!collection) return [];
	if (Array.isArray(collection)) return collection as DataviewChildItemLike[];
	if (typeof (collection as { array?: unknown }).array === 'function') {
		return (collection as { array: () => DataviewChildItemLike[] }).array();
	}
	if (Array.isArray((collection as { values?: unknown }).values)) {
		return (collection as { values: DataviewChildItemLike[] }).values;
	}
	if (typeof (collection as Iterable<DataviewChildItemLike>)[Symbol.iterator] === 'function') {
		return Array.from(collection as Iterable<DataviewChildItemLike>);
	}
	return [];
}

/**
 * 从 Dataview 任务对象的 `children` 树提取一级子任务与多级 bullet items，
 * 语义与 `extractTaskChildrenFromLines` 保持 100% 一致，且绝不持有 Dataview 私有对象引用。
 */
export function extractTaskChildrenFromDataview(
	rawChildren: DataviewChildItemLike['children'] | undefined | null,
	globalTaskFilter?: string
): ParsedTaskChildren {
	const subtasks: TaskSubtask[] = [];
	const bulletItems: TaskBulletItem[] = [];

	const walk = (items: DataviewChildItemLike[], level: number): void => {
		for (const item of items) {
			if (!item || typeof item !== 'object') continue;
			const line = typeof item.line === 'number' && Number.isFinite(item.line) ? item.line + 1 : 0;
			const rawText = typeof item.text === 'string' ? item.text : '';
			const firstLineEnd = rawText.search(/\r?\n/);
			const firstLine = firstLineEnd >= 0 ? rawText.slice(0, firstLineEnd) : rawText;

			const isTask = item.task === true || (typeof item.status === 'string' && item.status.length > 0);
			if (isTask) {
				if (level === 0) {
					const symbolChar =
						typeof item.status === 'string' && item.status.length > 0
							? item.status
							: item.completed === true
								? 'x'
								: ' ';
					const { completed, cancelled, status } = parseCheckboxStatus(symbolChar);
					subtasks.push({
						lineNumber: line,
						checkboxSymbol: symbolChar,
						completed,
						cancelled,
						status,
						description: cleanSubtaskDescription(firstLine, globalTaskFilter),
						rawContent: firstLine,
					});
				}
				// 子任务下的任何子项（含 bullet 与二级子任务）一律不递归收集
				continue;
			}

			const marker = typeof item.symbol === 'string' && item.symbol ? item.symbol : '-';
			bulletItems.push({
				lineNumber: line,
				level,
				marker,
				text: firstLine.trim(),
			});

			const nested = toChildArray(item.children);
			if (nested.length > 0) {
				walk(nested, level + 1);
			}
		}
	};

	walk(toChildArray(rawChildren), 0);
	return { subtasks, bulletItems };
}

/**
 * 将 bullet items 格式化为兼容任务编辑框（Live Preview / 多级纯文字）的多行文本。
 * 每一级缩进使用 2 个空格 + 列表标记，既兼容 Obsidian Live Preview 渲染，也支持纯文字多级编辑。
 */
export function formatBulletItemsForEditor(bulletItems: readonly TaskBulletItem[] | undefined): string {
	if (!bulletItems || bulletItems.length === 0) return '';
	return bulletItems
		.map((item) => `${'  '.repeat(item.level)}${item.marker || '-'} ${item.text}`)
		.join('\n');
}

/**
 * 将编辑框中的多行文本序列化为缩进在父任务下方的 Markdown bullet 行。
 * - 自动兼容带 `- ` / `* ` / `+ ` / `1. ` 的列表行与不带标记的纯文字多级缩进行
 * - 过滤掉误输入的复选框任务行前缀（不会把普通备注意外写成子任务）
 */
export function serializeBulletTextToLines(
	text: string,
	parentIndent: string,
	childIndentUnit: string
): string[] {
	const rawLines = text.split(/\r?\n/);
	const parsed: Array<{ indentWidth: number; marker: string; body: string }> = [];

	for (const raw of rawLines) {
		if (!raw.trim()) continue;
		const match = raw.match(RegularExpressions.editorBulletLineRegex);
		if (!match) continue;
		const leading = match[1] ?? '';
		const marker = match[2] ?? '-';
		const body = (match[3] ?? '').trim();
		if (!body) continue;

		// 计算编辑框内的相对缩进（tab=2 格，方便与 2-space 对齐）
		let width = 0;
		for (let i = 0; i < leading.length; i++) {
			width += leading[i] === '\t' ? 2 : 1;
		}
		parsed.push({ indentWidth: width, marker, body });
	}

	if (parsed.length === 0) return [];

	// 归一化相对缩进层级：按出现过的缩进栈折算为 0, 1, 2...
	const stack: number[] = [];
	return parsed.map(({ indentWidth, marker, body }) => {
		while (stack.length > 0 && stack[stack.length - 1] >= indentWidth) {
			stack.pop();
		}
		const level = stack.length;
		stack.push(indentWidth);
		const extraIndent = childIndentUnit.repeat(level + 1);
		return `${parentIndent}${extraIndent}${marker} ${body}`;
	});
}

export interface SubtaskTogglePatch {
	/** 原始 1-based 行号（优先匹配） */
	lineNumber: number;
	/** 原始描述（行号漂移时兜底匹配） */
	rawContent?: string;
	/** 目标完成状态 */
	completed: boolean;
}

/** 检测父任务下方子块实际使用的单级缩进单位（优先沿用原文件风格，默认 tab） */
function detectChildIndentUnit(lines: readonly string[], taskLineIndex: number, blockEnd: number): string {
	const parent = measureLineIndent(lines[taskLineIndex]);
	for (let i = taskLineIndex + 1; i < blockEnd; i++) {
		const line = lines[i];
		if (isBlankOrQuoteOnly(line)) continue;
		const cur = measureLineIndent(line);
		if (cur.wsIndent.length > parent.wsIndent.length && cur.wsIndent.startsWith(parent.wsIndent)) {
			const diff = cur.wsIndent.slice(parent.wsIndent.length);
			if (diff.length > 0) return diff;
		}
		if (cur.wsIndent.includes('\t')) return '\t';
		const delta = cur.indentWidth - parent.indentWidth;
		if (delta > 0) return ' '.repeat(delta);
	}
	return '\t';
}

/**
 * 原子更新任务下方的子任务勾选状态与 bullet items：
 * - 仅改动 `subtaskToggles` 指定的直接一级子任务的复选框字符，保留该子任务及其下级全部原样不动
 * - 仅当 `bulletText !== undefined` 时重写任务自身的非子任务 bullet 行，同时完整保留所有子任务子树
 */
export function applyTaskChildrenUpdates(
	lines: string[],
	taskLineIndex: number,
	options: {
		subtaskToggles?: SubtaskTogglePatch[];
		bulletText?: string | null;
		lineDelta?: number;
	}
): void {
	const { subtaskToggles, bulletText, lineDelta = 0 } = options;
	const hasSubtaskPatches = Boolean(subtaskToggles && subtaskToggles.length > 0);
	const hasBulletUpdate = bulletText !== undefined;
	if (!hasSubtaskPatches && !hasBulletUpdate) return;

	const blockEnd = findTaskChildBlockEnd(lines, taskLineIndex);
	const parent = measureLineIndent(lines[taskLineIndex]);
	const parentFullIndent = `${parent.quotePrefix}${parent.wsIndent}`;
	const childIndentUnit = detectChildIndentUnit(lines, taskLineIndex, blockEnd);

	// 1. 先在原位置切分出所有子任务子树（连同其下级原样保留）和需要更新的直接一级子任务行
	let directChildIndent: number | null = null;
	let inSubtaskIndent: number | null = null;
	const preservedSubtaskLines: string[] = [];
	const directSubtaskLineIndices: number[] = [];

	for (let i = taskLineIndex + 1; i < blockEnd; i++) {
		const line = lines[i];
		if (isBlankOrQuoteOnly(line)) {
			if (inSubtaskIndent !== null) {
				preservedSubtaskLines.push(line);
			}
			continue;
		}
		const cur = measureLineIndent(line);
		if (inSubtaskIndent !== null) {
			if (cur.indentWidth > inSubtaskIndent) {
				preservedSubtaskLines.push(line);
				continue;
			}
			inSubtaskIndent = null;
		}
		if (directChildIndent === null || cur.indentWidth < directChildIndent) {
			directChildIndent = cur.indentWidth;
		}
		const taskMatch = parseTaskLine(line);
		if (taskMatch) {
			inSubtaskIndent = cur.indentWidth;
			if (cur.indentWidth === directChildIndent) {
				directSubtaskLineIndices.push(i);
			}
			preservedSubtaskLines.push(line);
		}
	}

	// 2. 应用一级子任务复选框变更
	if (hasSubtaskPatches && subtaskToggles) {
		const patchedLines = new Map<number, string>();
		for (const patch of subtaskToggles) {
			const expectedIdx = patch.lineNumber - 1 + lineDelta;
			let targetIdx = directSubtaskLineIndices.includes(expectedIdx) ? expectedIdx : -1;
			if (targetIdx === -1 && patch.rawContent !== undefined) {
				targetIdx = directSubtaskLineIndices.find((idx) => {
					const m = parseTaskLine(lines[idx]);
					return m && m.content === patch.rawContent;
				}) ?? -1;
			}
			if (targetIdx === -1) continue;
			const m = parseTaskLine(lines[targetIdx]);
			if (!m) continue;
			const nextChar = patch.completed ? 'x' : ' ';
			const updated = `${m.indent}${m.listMarker} [${nextChar}] ${m.content}`.trimEnd();
			patchedLines.set(targetIdx, updated);
		}

		if (!hasBulletUpdate) {
			// 未修改 bullet items：直接原地替换勾选的子任务行，不重排任何其它行
			for (const [idx, updatedLine] of patchedLines) {
				lines[idx] = updatedLine;
			}
			return;
		}

		// 若同时修改了 bullet items，先把补丁同步到原行再重新提取保留的子任务块
		for (const [idx, updatedLine] of patchedLines) {
			lines[idx] = updatedLine;
		}
	}

	// 3. 重新收集被保留的子任务块（确保已含最新复选框状态）并替换任务子块
	if (hasBulletUpdate) {
		const keptSubtaskLines: string[] = [];
		let skipIndent: number | null = null;
		for (let i = taskLineIndex + 1; i < blockEnd; i++) {
			const line = lines[i];
			if (isBlankOrQuoteOnly(line)) {
				if (skipIndent !== null) keptSubtaskLines.push(line);
				continue;
			}
			const cur = measureLineIndent(line);
			if (skipIndent !== null) {
				if (cur.indentWidth > skipIndent) {
					keptSubtaskLines.push(line);
					continue;
				}
				skipIndent = null;
			}
			if (parseTaskLine(line)) {
				skipIndent = cur.indentWidth;
				keptSubtaskLines.push(line);
			}
		}

		// 去掉尾部因空行带入的多余空白
		while (keptSubtaskLines.length > 0 && isBlankOrQuoteOnly(keptSubtaskLines[keptSubtaskLines.length - 1])) {
			keptSubtaskLines.pop();
		}

		const nextBulletLines =
			bulletText && bulletText.trim()
				? serializeBulletTextToLines(bulletText, parentFullIndent, childIndentUnit)
				: [];

		const replacement = [...nextBulletLines, ...keptSubtaskLines];
		lines.splice(taskLineIndex + 1, blockEnd - (taskLineIndex + 1), ...replacement);
	}
}
