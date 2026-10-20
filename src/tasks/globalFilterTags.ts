/**
 * 写任务行时「全局筛选符 + 标签」的合并（序列化与新建任务共用）：
 * 标签形式的筛选符（#task）本身也会出现在标签列表里，直接拼接会写成 "#task #task"。
 * - 标签列表里剔除与筛选符相同的标签
 * - 已有其子标签（#task/work）时，标签写在行首即满足筛选，不再补写筛选符
 */
export function mergeGlobalFilterAndTags(
	globalFilter: string,
	tags: readonly string[] | undefined,
): { filter: string | null; tags: string[] } {
	const filter = globalFilter.trim();
	const all = (tags ?? []).map((t) => t.trim()).filter(Boolean);
	if (!filter) return { filter: null, tags: all };
	const tagName = filter.startsWith('#') ? filter.slice(1) : '';
	if (!tagName) return { filter, tags: all };
	const hasSubTag = all.some((t) => t.startsWith(`${tagName}/`));
	return { filter: hasSubTag ? null : filter, tags: all.filter((t) => t !== tagName) };
}
