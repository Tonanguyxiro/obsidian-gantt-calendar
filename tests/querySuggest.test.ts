import { applySuggestion, getQuerySuggestions, type SuggestVocab } from '../src/filters/querySuggest';
import { detectFileEngine, detectTaskEngine, runDatacoreQuery, runDataviewFileQuery, dataviewFileSource } from '../src/filters/queryEngines';
import { insertExample, TASK_QUERY_EXAMPLES, FILE_QUERY_EXAMPLES } from '../src/filters/queryExamples';
import { compileTaskQuery } from '../src/filters/taskQuery';
import { compileExpression } from '../src/filters/baseExpression';
import type { App } from 'obsidian';

const vocab: SuggestVocab = {
	tags: ['project', 'project/alpha', 'task', 'work'],
	folders: ['Projects', 'Projects/Alpha', 'Journal/Daily'],
	properties: ['status', 'project', 'start', 'end'],
	propertyValues: (k) => (k === 'status' ? ['done', 'doing', 'todo'] : []),
	today: '2026-11-12',
};

/** 用 | 标记光标位置 */
function at(engine: Parameters<typeof getQuerySuggestions>[0], marked: string, opts = {}) {
	const caret = marked.indexOf('|');
	const text = marked.replace('|', '');
	return { text, caret, res: getQuerySuggestions(engine, text, caret, vocab, opts) };
}
const labels = (r: ReturnType<typeof getQuerySuggestions>) => (r ? r.items.map((i) => i.label) : []);

describe('querySuggest — Tasks', () => {
	it('前缀给出过滤器短语，替换当前片段', () => {
		const { text, res } = at('tasks', 'not done\ndue b|');
		expect(labels(res)[0]).toBe('due before');
		const applied = applySuggestion(text, res!, res!.items[0]);
		expect(applied.text).toBe('not done\ndue before ');
		expect(applied.caret).toBe(applied.text.length);
	});

	it('词首 / 包含匹配：输入 "start" 命中 has start date', () => {
		expect(labels(at('tasks', 'start|').res)).toEqual(expect.arrayContaining(['has start date', 'no start date']));
		expect(labels(at('tasks', 'start|').res)[0]).toBe('starts before');
	});

	it('tag includes 之后给 #标签（即使为空）', () => {
		const { res } = at('tasks', 'tag includes |');
		expect(labels(res)).toEqual(['#project', '#project/alpha', '#task', '#work']);
		const r2 = at('tasks', 'tags include #al|').res!;
		expect(labels(r2)).toEqual(['#project/alpha']);
		expect(r2.from).toBe('tags include '.length);
	});

	it('path includes 之后给文件夹（带 /），priority / status.type / 日期给可选值', () => {
		expect(labels(at('tasks', 'path includes Pro|').res)).toEqual(['Projects', 'Projects/Alpha']);
		expect(at('tasks', 'path includes Pro|').res!.items[0].insert).toBe('Projects/');
		expect(labels(at('tasks', 'priority above |').res)).toContain('high');
		expect(labels(at('tasks', 'status.type is |').res)).toEqual(['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED']);
		expect(labels(at('tasks', 'due before |').res)).toEqual(expect.arrayContaining(['today', 'tomorrow', '2026-11-12']));
	});

	it('"due on o" 不是日期值时落到关键字（due on or before）', () => {
		expect(labels(at('tasks', 'due on o|').res)).toEqual(['due on or before', 'due on or after']);
	});

	it('括号 / AND 之后按新片段补全；大写 A 给布尔运算符', () => {
		const r = at('tasks', '(not done) AND (sch|').res!;
		expect(labels(r)[0]).toBe('scheduled before');
		expect(r.from).toBe('(not done) AND ('.length);
		expect(labels(at('tasks', '(not done) A|').res)).toEqual(['AND']);
	});

	it('空片段只在显式触发时给关键字', () => {
		expect(at('tasks', '|').res).toBeNull();
		expect(at('tasks', 'not done\n|').res).toBeNull();
		expect(labels(at('tasks', '|', { explicit: true }).res).length).toBeGreaterThan(10);
	});

	it('已完整输入的候选不再提示', () => {
		expect(labels(at('tasks', 'not done|').res)).not.toContain('not done');
	});
});

describe('querySuggest — Bases', () => {
	it('file. 后给成员与方法；方法插入后光标落在引号内', () => {
		const { text, res } = at('bases', 'file.has|');
		expect(labels(res)).toEqual(['hasTag("")', 'hasProperty("")', 'hasLink("")']);
		const applied = applySuggestion(text, res!, res!.items[0]);
		expect(applied.text).toBe('file.hasTag("")');
		expect(applied.caret).toBe('file.hasTag("'.length);
	});

	it('file.hasTag(" 内给不带 # 的标签，file.inFolder(" 内给文件夹', () => {
		const r = at('bases', 'file.hasTag("pro|")').res!;
		expect(r.items.map((i) => i.insert)).toEqual(['project', 'project/alpha']);
		expect(labels(at('bases', 'file.inFolder("|")').res)).toEqual(['Projects', 'Projects/Alpha', 'Journal/Daily']);
	});

	it('顶层给 file.* 与属性名；note. 后给属性名', () => {
		const top = labels(at('bases', 'sta|').res);
		expect(top).toContain('status');
		expect(top).toContain('start');
		expect(labels(at('bases', 'fi|').res)[0]).toBe('file.name');
		expect(labels(at('bases', 'note.st|').res)).toEqual(['status', 'start']);
	});

	it('比较右侧给属性值', () => {
		expect(labels(at('bases', 'status != "do|').res)).toEqual(['done', 'doing']);
		expect(labels(at('bases', 'note.status == "|').res)).toEqual(['done', 'doing', 'todo']);
	});

	it('其他值后的 . 给值方法', () => {
		expect(labels(at('bases', 'status.cont|').res)).toEqual(['contains("")', 'containsAny("")', 'containsAll("")']);
	});
});

describe('querySuggest — Dataview / Datacore', () => {
	it('Dataview：关键字、# 标签、FROM 引号内的文件夹（补闭合引号）', () => {
		expect(labels(at('dataview', 'TASK WH|').res)).toEqual(['WHERE']);
		expect(labels(at('dataview', 'TASK FROM #pro|').res)).toEqual(['#project', '#project/alpha']);
		const r = at('dataview', 'TASK FROM "Jou|').res!;
		expect(r.items[0].insert).toBe('Journal/Daily"');
		expect(at('dataview', 'TASK FROM "Jou|"').res!.items[0].insert).toBe('Journal/Daily');
	});

	it('Dataview 文件页给 LIST / file.mtime 与属性名，任务页给 completed', () => {
		expect(labels(at('dataview', 'LIS|', { page: 'file' }).res)).toContain('LIST');
		expect(labels(at('dataview', 'LIST WHERE sta|', { page: 'file' }).res)).toContain('status');
		expect(labels(at('dataview', 'TASK WHERE !comp|', { page: 'task' }).res)).toContain('!completed');
	});

	it('Datacore：@ 类型、$ 字段、path(" 内文件夹', () => {
		expect(labels(at('datacore', '@ta|').res)).toEqual(['@task']);
		expect(labels(at('datacore', '@task and $comp|').res)).toEqual(['$completed']);
		expect(labels(at('datacore', '@page and path("Pro|")', { page: 'file' }).res)).toEqual(['Projects', 'Projects/Alpha']);
		expect(labels(at('datacore', '@page and #wo|', { page: 'file' }).res)).toEqual(['#work']);
	});
});

describe('queryEngines — 引擎识别', () => {
	it('任务页：TASK → Dataview，@ → Datacore，其余 Tasks', () => {
		expect(detectTaskEngine('TASK WHERE !completed')).toBe('dataview');
		expect(detectTaskEngine('# note\n@task and $completed = false')).toBe('datacore');
		expect(detectTaskEngine('not done')).toBe('tasks');
		expect(detectTaskEngine('')).toBe('tasks');
	});

	it('文件页：大写 LIST / TABLE / FROM → Dataview，@ → Datacore，其余 Bases（小写 from 属性仍是 Bases）', () => {
		expect(detectFileEngine('FROM "Projects"')).toBe('dataview');
		expect(detectFileEngine('LIST WHERE x')).toBe('dataview');
		expect(detectFileEngine('TABLE file.mtime')).toBe('dataview');
		expect(detectFileEngine('@page and #x')).toBe('datacore');
		expect(detectFileEngine('from == "x"')).toBe('bases');
		expect(detectFileEngine('file.hasTag("x")')).toBe('bases');
	});

	it('只有 FROM 时补成 LIST FROM；// 注释被去掉', () => {
		expect(dataviewFileSource('// c\nFROM "A"')).toBe('LIST FROM "A"');
		expect(dataviewFileSource('LIST\nFROM "A"')).toBe('LIST\nFROM "A"');
	});
});

const appWith = (plugins: Record<string, unknown>): App => ({ plugins: { plugins } } as unknown as App);

describe('queryEngines — 执行', () => {
	it('Datacore 任务：$line 0 起 → 路径:行号 1 起；#标签行不被当成注释', async () => {
		const tryQuery = jest.fn().mockReturnValue({ successful: true, value: [{ $file: 'a.md', $line: 0 }, { $file: 'b.md', $line: 9 }] });
		const r = await runDatacoreQuery(appWith({ datacore: { api: { tryQuery } } }), '@task and\n#work\n// note', 'task');
		expect([...r.keys!]).toEqual(['a.md:1', 'b.md:10']);
		expect(tryQuery).toHaveBeenCalledWith('@task and #work');
	});

	it('Datacore 文件：$path；任务页查到非任务时报错；解析抛错 / 未安装给出错误', async () => {
		const pages = { tryQuery: () => ({ successful: true, value: [{ $path: 'x.md' }] }) };
		expect([...(await runDatacoreQuery(appWith({ datacore: { api: pages } }), '@page', 'file')).keys!]).toEqual(['x.md']);
		expect((await runDatacoreQuery(appWith({ datacore: { api: pages } }), '@page', 'task')).keys).toBeNull();
		const throws = { tryQuery: () => { throw new Error('-- PARSING FAILED --\nGot the end of the input'); } };
		const bad = await runDatacoreQuery(appWith({ datacore: { api: throws } }), '@task and (', 'task');
		expect(bad.keys).toBeNull();
		expect(bad.error).toContain('PARSING FAILED');
		expect((await runDatacoreQuery(appWith({}), '@task', 'task')).error).toBeTruthy();
	});

	it('Dataview 文件：LIST 链接 / TABLE 首列；GROUP BY 无链接时报错', async () => {
		const list = { query: jest.fn().mockResolvedValue({ successful: true, value: { type: 'list', values: [{ path: 'a.md' }, { path: 'b.md' }] } }) };
		expect([...(await runDataviewFileQuery(appWith({ dataview: { api: list } }), 'FROM "X"')).keys!]).toEqual(['a.md', 'b.md']);
		expect(list.query).toHaveBeenCalledWith('LIST FROM "X"');
		const table = { query: async () => ({ successful: true, value: { type: 'table', values: { array: () => [[{ path: 'c.md' }, 1]] } } }) };
		expect([...(await runDataviewFileQuery(appWith({ dataview: { api: table } }), 'TABLE x')).keys!]).toEqual(['c.md']);
		const grouped = { query: async () => ({ successful: true, value: { type: 'list', values: ['Folder'] } }) };
		expect((await runDataviewFileQuery(appWith({ dataview: { api: grouped } }), 'LIST GROUP BY file.folder')).keys).toBeNull();
		const task = { query: async () => ({ successful: true, value: { type: 'task', values: [] } }) };
		expect((await runDataviewFileQuery(appWith({ dataview: { api: task } }), 'LIST')).keys).toBeNull();
	});
});

describe('queryExamples', () => {
	it('Tasks / Bases 示例在同引擎已有内容时追加为新行，其余整体替换', () => {
		expect(insertExample('not done\n', 'tasks', 'has tags', 'tasks')).toBe('not done\nhas tags');
		expect(insertExample('not done', 'tasks', 'TASK', 'dataview')).toBe('TASK');
		expect(insertExample('TASK', 'dataview', 'not done', 'tasks')).toBe('not done');
		expect(insertExample('', 'bases', 'file.hasTag("x")', 'bases')).toBe('file.hasTag("x")');
	});

	it('内置 Tasks / Bases 示例都能被本插件求值器编译', () => {
		for (const ex of TASK_QUERY_EXAMPLES.find((g) => g.engine === 'tasks')!.examples) {
			expect(compileTaskQuery(ex).errors).toEqual([]);
		}
		for (const ex of FILE_QUERY_EXAMPLES.find((g) => g.engine === 'bases')!.examples) {
			expect(() => compileExpression(ex)).not.toThrow();
		}
		for (const g of TASK_QUERY_EXAMPLES) for (const ex of g.examples) expect(detectTaskEngine(ex)).toBe(g.engine);
		for (const g of FILE_QUERY_EXAMPLES) for (const ex of g.examples) expect(detectFileEngine(ex)).toBe(g.engine);
	});
});
