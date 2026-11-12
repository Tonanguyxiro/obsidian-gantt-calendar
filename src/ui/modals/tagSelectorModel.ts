/**
 * 标签选择器的纯数据模型（无 React / DOM 依赖，便于单测）
 *
 * - 层级树复用 `buildTagHierarchy`，不另建树
 * - 计数按「任务」聚合：父标签计数 = 带有它或其任一子孙标签的任务数（每个任务只计一次）
 */

import type { GCTask } from '../../types';
import { buildTagHierarchy, getAncestorPaths } from '../../tasks/tags/TagHierarchyBuilder';
import type { TagNode } from '../../tasks/tags/TagHierarchy';
import { RegularExpressions } from '../../utils/RegularExpressions';

export interface TagSelectorModel {
	/** 一级标签（按聚合计数降序） */
	roots: TagNode[];
	/** fullPath → 节点 */
	nodes: Map<string, TagNode>;
	/** fullPath → 聚合任务数 */
	counts: Map<string, number>;
}

/** 构建层级模型：节点 children 均按聚合计数降序、同数按名称排序 */
export function buildTagSelectorModel(allTasks: Pick<GCTask, 'tags'>[]): TagSelectorModel {
	const counts = new Map<string, number>();
	for (const task of allTasks) {
		if (!task.tags || task.tags.length === 0) continue;
		const paths = new Set<string>();
		for (const tag of task.tags) {
			if (!tag) continue;
			paths.add(tag);
			for (const ancestor of getAncestorPaths(tag)) paths.add(ancestor);
		}
		for (const p of paths) counts.set(p, (counts.get(p) || 0) + 1);
	}

	const roots = buildTagHierarchy(Array.from(counts.keys()));
	const nodes = new Map<string, TagNode>();
	const byCount = (a: TagNode, b: TagNode) =>
		(counts.get(b.fullPath) || 0) - (counts.get(a.fullPath) || 0) || a.fullPath.localeCompare(b.fullPath);
	const visit = (list: TagNode[]) => {
		list.sort(byCount);
		for (const node of list) {
			node.taskCount = counts.get(node.fullPath) || 0;
			nodes.set(node.fullPath, node);
			visit(node.children);
		}
	};
	visit(roots);
	return { roots, nodes, counts };
}

/**
 * 逐级展开的行：第 0 行为一级标签，第 i 行为 `expandedPath[i-1]` 的直接子标签。
 * 展开路径中途断开（节点不存在或无子标签）时到此为止。
 */
export function getDrillDownRows(model: TagSelectorModel, expandedPath: string[]): TagNode[][] {
	const rows: TagNode[][] = [model.roots];
	for (const path of expandedPath) {
		const node = model.nodes.get(path);
		if (!node || node.children.length === 0) break;
		rows.push(node.children);
	}
	return rows;
}

/** 点击第 `level` 行的 `fullPath` 后新的展开路径：已展开则收起到其父级，否则展开到它 */
export function toggleExpandedPath(expandedPath: string[], level: number, fullPath: string): string[] {
	if (expandedPath[level] === fullPath) return expandedPath.slice(0, level);
	return [...expandedPath.slice(0, level), fullPath];
}

/** 展开到指定标签：路径为其全部祖先 + 自身 */
export function expandedPathFor(fullPath: string): string[] {
	return [...getAncestorPaths(fullPath), fullPath];
}

/** 搜索：扁平列出任意层级中路径包含关键词的标签（按聚合计数降序） */
export function searchTags(model: TagSelectorModel, query: string, limit: number): Array<[string, number]> {
	const q = normalizeTagInput(query).toLowerCase();
	if (!q) return [];
	return Array.from(model.counts.entries())
		.filter(([tag]) => tag.toLowerCase().includes(q))
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit);
}

/** 输入框文本 → 标签路径（去首尾空白与开头的 #） */
export function normalizeTagInput(input: string): string {
	return input.trim().replace(RegularExpressions.FileTask.leadingHash, '');
}

// ==================== 层级合并：子标签已包含父标签 ====================
// #task/project 在 Obsidian 的标签检索里同时命中 #task，同时选父子是冗余的：
// 选择集只保留最具体的标签。

const lc = (t: string): string => t.toLowerCase();

/** ancestor 是否为 tag 的上级（task 是 task/project 的上级；不区分大小写，不含自身） */
export function isAncestorTag(ancestor: string, tag: string): boolean {
	return lc(tag).startsWith(`${lc(ancestor)}/`);
}

/** 该标签是否已被某个已选的子标签涵盖（显示为「已包含」） */
export function isImpliedTag(tag: string, selected: Iterable<string>): boolean {
	for (const s of selected) if (isAncestorTag(tag, s)) return true;
	return false;
}

/**
 * 把标签加入选择：
 * - 已被某个已选子标签涵盖（选 #task 时已有 #task/project）→ 不变
 * - 否则加入，并移除被它涵盖的已选上级（选 #task/project 时去掉 #task）
 */
export function addTagMerged(selected: string[], tag: string): string[] {
	if (selected.some((s) => lc(s) === lc(tag)) || isImpliedTag(tag, selected)) return selected;
	return [...selected.filter((s) => !isAncestorTag(s, tag)), tag];
}

/** 合并一组标签：去掉被其他标签涵盖的上级，保持原顺序（用于初始选择） */
export function mergeTagSet(tags: string[]): string[] {
	return tags.reduce<string[]>((acc, t) => addTagMerged(acc, t), []);
}
