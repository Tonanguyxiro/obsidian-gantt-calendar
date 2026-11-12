/**
 * 筛选面板的可点击示例（按引擎分组）
 */

import type { FileEngine, QueryEngine, TaskEngine } from './queryEngines';

export interface QueryExampleGroup<E extends QueryEngine> {
	engine: E;
	examples: string[];
}

export const TASK_QUERY_EXAMPLES: QueryExampleGroup<TaskEngine>[] = [
	{
		engine: 'tasks',
		examples: [
			'not done\ndue before tomorrow',
			'not done\nscheduled this week',
			'tag includes #project',
			'path includes Projects/\npriority above none',
			'(due on today) OR (scheduled on today)',
		],
	},
	{
		engine: 'dataview',
		examples: [
			'TASK WHERE !completed AND due <= date(today)',
			'TASK FROM "Projects" WHERE !completed',
			'TASK FROM #project WHERE !completed GROUP BY file.link',
		],
	},
	{
		engine: 'datacore',
		examples: [
			'@task and $completed = false',
			'@task and #project and $completed = false',
			'@task and childof(@page and path("Projects"))',
		],
	},
];

export const FILE_QUERY_EXAMPLES: QueryExampleGroup<FileEngine>[] = [
	{
		engine: 'bases',
		examples: [
			'file.inFolder("Projects")',
			'file.hasTag("project")',
			'status != "done"',
			'file.mtime > now() - "7d"',
		],
	},
	{
		engine: 'dataview',
		examples: [
			'FROM "Projects"',
			'LIST FROM #project WHERE status != "done"',
			'LIST WHERE file.mtime >= date(today) - dur(7 days)',
		],
	},
	{
		engine: 'datacore',
		examples: [
			'@page and path("Projects")',
			'@page and #project',
		],
	},
];

/**
 * 点击示例后的新内容：与当前同为逐行组合的引擎（Tasks / Bases）且已有内容时追加为新行，
 * 否则整体替换（Dataview / Datacore 是整段查询，不能与其他行混写）
 */
export function insertExample(current: string, currentEngine: QueryEngine, example: string, exampleEngine: QueryEngine): string {
	const lineBased = exampleEngine === 'tasks' || exampleEngine === 'bases';
	const trimmed = current.trimEnd();
	if (lineBased && currentEngine === exampleEngine && trimmed) return `${trimmed}\n${example}`;
	return example;
}
