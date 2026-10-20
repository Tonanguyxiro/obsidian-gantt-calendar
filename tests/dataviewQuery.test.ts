import { isDataviewQuery, dataviewTaskKey, runDataviewTaskQuery } from '../src/filters/dataviewQuery';
import type { App } from 'obsidian';

const appWith = (api: unknown): App => ({ plugins: { plugins: api ? { dataview: { api } } : {} } } as unknown as App);

describe('dataviewQuery', () => {
	it('isDataviewQuery：首个非空非注释行以 TASK 开头才算（不区分大小写）', () => {
		expect(isDataviewQuery('TASK FROM "Projects" WHERE !completed')).toBe(true);
		expect(isDataviewQuery('  task\nWHERE !completed')).toBe(true);
		expect(isDataviewQuery('# 注释\n\nTASK')).toBe(true);
		expect(isDataviewQuery('not done\ndue before 2026-11-01')).toBe(false);
		expect(isDataviewQuery('tag includes #task')).toBe(false);
		expect(isDataviewQuery('TASKS')).toBe(false);
		expect(isDataviewQuery('')).toBe(false);
	});

	it('键 = 路径:行号（Dataview 行号 0 起 → 本插件 1 起）', async () => {
		const api = { query: jest.fn().mockResolvedValue({ successful: true, value: { type: 'task', values: [{ path: 'a.md', line: 0 }, { path: 'b.md', line: 4 }] } }) };
		const r = await runDataviewTaskQuery(appWith(api), 'TASK');
		expect([...r.keys!]).toEqual(['a.md:1', 'b.md:5']);
		expect(dataviewTaskKey({ filePath: 'b.md', lineNumber: 5 })).toBe('b.md:5');
	});

	it('GROUP BY 的嵌套 rows 被展开；DataArray（.array()）也支持；# 注释行不传给 Dataview', async () => {
		const values = { array: () => [{ rows: [{ path: 'a.md', line: 1 }, { path: 'a.md', line: 2 }] }, { rows: [{ path: 'c.md', line: 0 }] }] };
		const api = { query: jest.fn().mockResolvedValue({ successful: true, value: { type: 'task', values } }) };
		const r = await runDataviewTaskQuery(appWith(api), '# note\nTASK GROUP BY file.link');
		expect([...r.keys!].sort()).toEqual(['a.md:2', 'a.md:3', 'c.md:1']);
		expect(api.query).toHaveBeenCalledWith('TASK GROUP BY file.link');
	});

	it('出错路径：未安装、语法错误、非 TASK 查询、抛异常——keys 为 null 且带错误信息', async () => {
		expect((await runDataviewTaskQuery(appWith(null), 'TASK')).keys).toBeNull();
		expect((await runDataviewTaskQuery(appWith(null), 'TASK')).error).toBeTruthy();

		const bad = { query: jest.fn().mockResolvedValue({ successful: false, error: 'Error: \n-- PARSING FAILED ---\n\nGot the end of the input\n\nExpected:\n\nWHERE <expression>\n' }) };
		const r1 = await runDataviewTaskQuery(appWith(bad), 'TASK WHERE !((');
		expect(r1.keys).toBeNull();
		expect(r1.error).toContain('Got the end of the input');

		const list = { query: jest.fn().mockResolvedValue({ successful: true, value: { type: 'list', values: [] } }) };
		expect((await runDataviewTaskQuery(appWith(list), 'LIST')).keys).toBeNull();

		const boom = { query: jest.fn().mockRejectedValue(new Error('boom')) };
		expect((await runDataviewTaskQuery(appWith(boom), 'TASK')).keys).toBeNull();
	});
});
