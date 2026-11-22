import {
	applyTagCompletion,
	buildTagSelectorModel,
	expandedPathFor,
	getDrillDownRows,
	normalizeTagInput,
	searchTags,
	suggestTags,
	toggleExpandedPath,
} from '../src/ui/modals/tagSelectorModel';

const tasks = [
	{ tags: ['task', 'task/pending'] },
	{ tags: ['task/pending'] },
	{ tags: ['task/tools'] },
	{ tags: ['research/paper'] },
	{ tags: ['research/others/hpcteam', 'research/paper'] },
	{ tags: ['research/others/hpcteam'] },
	{ tags: ['research/others/hpcteam'] },
	{ tags: ['coding'] },
	{ tags: [] },
	{},
];

describe('tagSelectorModel', () => {
	const model = buildTagSelectorModel(tasks);

	test('一级标签按聚合计数降序，计数每任务只计一次', () => {
		expect(model.roots.map(n => n.fullPath)).toEqual(['research', 'task', 'coding']);
		expect(model.counts.get('research')).toBe(4);
		// 第一个任务同时带 task 和 task/pending，只算一次
		expect(model.counts.get('task')).toBe(3);
		expect(model.counts.get('task/pending')).toBe(2);
		expect(model.counts.get('research/others')).toBe(3);
		expect(model.nodes.get('research')?.taskCount).toBe(4);
	});

	test('逐级展开的行为直接子标签', () => {
		expect(getDrillDownRows(model, [])).toHaveLength(1);
		const rows = getDrillDownRows(model, ['research', 'research/others']);
		expect(rows.map(r => r.map(n => n.fullPath))).toEqual([
			['research', 'task', 'coding'],
			['research/others', 'research/paper'],
			['research/others/hpcteam'],
		]);
		// 无子标签或不存在的节点到此为止
		expect(getDrillDownRows(model, ['coding'])).toHaveLength(1);
		expect(getDrillDownRows(model, ['missing', 'x'])).toHaveLength(1);
	});

	test('展开路径切换与收起', () => {
		expect(toggleExpandedPath([], 0, 'task')).toEqual(['task']);
		expect(toggleExpandedPath(['task'], 0, 'research')).toEqual(['research']);
		expect(toggleExpandedPath(['research', 'research/others'], 0, 'research')).toEqual([]);
		expect(toggleExpandedPath(['research', 'research/others'], 1, 'research/others')).toEqual(['research']);
		expect(expandedPathFor('a/b/c')).toEqual(['a', 'a/b', 'a/b/c']);
	});

	test('搜索扁平匹配任意层级', () => {
		expect(searchTags(model, '', 10)).toEqual([]);
		expect(searchTags(model, '#HPC', 10)).toEqual([['research/others/hpcteam', 3]]);
		expect(searchTags(model, 'pa', 10).map(([t]) => t)).toEqual(['research/paper']);
		expect(searchTags(model, 'task', 10).map(([t]) => t)).toEqual(['task', 'task/pending', 'task/tools']);
		expect(searchTags(model, 'e', 2)).toHaveLength(2);
		expect(normalizeTagInput('  #new/tag ')).toBe('new/tag');
	});

	test('自动补全建议优先前缀匹配，其次按计数与字典序', () => {
		expect(suggestTags(model, '', 10)).toEqual([]);
		expect(suggestTags(model, '  #  ', 10)).toEqual([]);
		// "co" 同时匹配前缀 coding(1)，以及子串中的其他不含 co 的跳过
		expect(suggestTags(model, 'co', 10)).toEqual([['coding', 1]]);
		// "pa" 仅匹配子串 research/paper(2)
		expect(suggestTags(model, '#pa', 10)).toEqual([['research/paper', 2]]);
		// 前缀优先于更高计数的子串：先建一个带前缀与高计数子串的模型
		const ranked = buildTagSelectorModel([
			{ tags: ['foo/bar'] },
			{ tags: ['foo/bar'] },
			{ tags: ['foo/bar'] },
			{ tags: ['bar'] },
		]);
		expect(suggestTags(ranked, 'bar', 10)).toEqual([
			['bar', 1],
			['foo/bar', 3],
		]);
		expect(suggestTags(model, 'e', 2)).toHaveLength(2);
	});

	test('补全写入输入框保留前导 # 且不追加斜杠或提交', () => {
		expect(applyTagCompletion('rel', 'release')).toBe('release');
		expect(applyTagCompletion('  #rel', 'release')).toBe('#release');
		expect(applyTagCompletion('#release/v0', 'release/v0-1-0')).toBe('#release/v0-1-0');
	});
});

import { addTagMerged, isImpliedTag, mergeTagSet } from '../src/ui/modals/tagSelectorModel';

describe('tag selection merging (child implies parent)', () => {
	test('selecting a child drops the selected ancestor', () => {
		expect(addTagMerged(['task'], 'task/project')).toEqual(['task/project']);
		expect(addTagMerged(['task', 'coding'], 'task/tool/obsidian')).toEqual(['coding', 'task/tool/obsidian']);
	});

	test('selecting an ancestor of a selected tag changes nothing', () => {
		const sel = ['task/project'];
		expect(addTagMerged(sel, 'task')).toBe(sel);
		expect(addTagMerged(sel, 'TASK')).toBe(sel);
	});

	test('siblings and look-alike prefixes are kept', () => {
		expect(addTagMerged(['task/project'], 'task/pending')).toEqual(['task/project', 'task/pending']);
		expect(addTagMerged(['task'], 'tasks/x')).toEqual(['task', 'tasks/x']);
		expect(addTagMerged(['research'], 'task')).toEqual(['research', 'task']);
	});

	test('implied state and initial merge', () => {
		expect(isImpliedTag('task', ['task/project'])).toBe(true);
		expect(isImpliedTag('task/project', ['task/project'])).toBe(false);
		expect(isImpliedTag('task', ['tasks/x'])).toBe(false);
		expect(mergeTagSet(['task', 'task/project', 'Task/project/a', 'coding'])).toEqual(['Task/project/a', 'coding']);
	});
});
