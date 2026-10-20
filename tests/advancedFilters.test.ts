import { compileExpression, FilterSyntaxError, type FileContext } from '../src/filters/baseExpression';
import { compileTaskQuery } from '../src/filters/taskQuery';
import { groupTagsByRoot } from '../src/components/tooltip/tooltipSections';
import { extractTags, extractTaskDescription } from '../src/tasks/taskParser/utils';
import { applyTagFilter } from '../src/ui/utils/taskFilters';
import type { GCTask } from '../src/types';

const file = (over: Partial<FileContext> = {}): FileContext => ({
	path: 'Projects/Alpha/Design.md', name: 'Design.md', basename: 'Design', ext: 'md', folder: 'Projects/Alpha',
	size: 10, ctime: new Date('2026-01-01'), mtime: new Date(), tags: ['project/alpha', 'ml'], links: ['Alpha'],
	frontmatter: { status: 'active', priority: 3, aliases: ['d1', 'd2'] }, ...over,
});

const task = (over: Partial<GCTask> = {}): GCTask => ({
	filePath: 'Projects/Alpha/Design.md', fileName: 'Design', lineNumber: 1, content: '', description: 'Write paper',
	completed: false, cancelled: false, priority: 'normal', ...over,
});

describe('Bases 表达式', () => {
	it('file.hasTag 含嵌套标签；inFolder 含子文件夹', () => {
		expect(compileExpression('file.hasTag("project")')(file())).toBe(true);
		expect(compileExpression('file.hasTag("#ml")')(file())).toBe(true);
		expect(compileExpression('file.hasTag("proj")')(file())).toBe(false);
		expect(compileExpression('file.inFolder("Projects")')(file())).toBe(true);
		expect(compileExpression('file.inFolder("Proj")')(file())).toBe(false);
	});
	it('属性比较、逻辑运算、方法', () => {
		expect(compileExpression('status == "active" && priority >= 3')(file())).toBe(true);
		expect(compileExpression('!(status == "active") || file.ext == "md"')(file())).toBe(true);
		expect(compileExpression('aliases.contains("d2")')(file())).toBe(true);
		expect(compileExpression('file.name.startsWith("Des")')(file())).toBe(true);
		expect(compileExpression('missing.isEmpty()')(file())).toBe(true);
		expect(compileExpression('note.status != "done"')(file())).toBe(true);
	});
	it('日期与时长', () => {
		expect(compileExpression('file.mtime > now() - "7d"')(file())).toBe(true);
		expect(compileExpression('file.ctime > now() - "7d"')(file())).toBe(false);
	});
	it('不支持的函数在编译期报错', () => {
		expect(() => compileExpression('file.frobnicate("x")')).toThrow(FilterSyntaxError);
		expect(() => compileExpression('status ==')).toThrow(FilterSyntaxError);
	});
});

describe('Tasks 查询', () => {
	const run = (q: string, t: GCTask) => {
		const c = compileTaskQuery(q);
		expect(c.errors).toEqual([]);
		return c.predicate ? c.predicate(t) : true;
	};
	it('状态与优先级', () => {
		expect(run('not done', task())).toBe(true);
		expect(run('done', task({ completed: true }))).toBe(true);
		expect(run('priority above none', task({ priority: 'high' }))).toBe(true);
		expect(run('priority is none', task({ priority: 'high' }))).toBe(false);
		expect(run('status.type is DONE', task({ completed: true }))).toBe(true);
	});
	it('日期', () => {
		expect(run('due before 2026-11-01', task({ dueDate: new Date(2026, 9, 19) }))).toBe(true);
		expect(run('due after 2026-11-01', task({ dueDate: new Date(2026, 9, 19) }))).toBe(false);
		expect(run('no due date', task())).toBe(true);
		expect(run('has due date', task())).toBe(false);
	});
	it('文本与标签', () => {
		expect(run('tag includes #proj', task({ tags: ['project/x'] }))).toBe(true);
		expect(run('tag does not include #proj', task({ tags: ['project/x'] }))).toBe(false);
		expect(run('no tags', task())).toBe(true);
		expect(run('path includes alpha', task())).toBe(true);
		expect(run('description regex matches /^write/i', task())).toBe(true);
	});
	it('布尔组合与多行 AND', () => {
		expect(run('(done) OR (description includes paper)', task())).toBe(true);
		expect(run('NOT (description includes paper)', task())).toBe(false);
		expect(run('not done\ndescription includes nope', task())).toBe(false);
	});
	it('无法识别的行记入 errors 且被忽略', () => {
		const c = compileTaskQuery('banana split\nnot done');
		expect(c.errors).toHaveLength(1);
		expect(c.predicate?.(task())).toBe(true);
	});
});

describe('多级标签', () => {
	it('按根聚合并大小写去重', () => {
		expect(groupTagsByRoot(['task', 'Task', 'nlp/decoding', 'nlp/decoding/spec', 'nlp', 'x/y'])).toEqual([
			{ root: 'task', children: [] },
			{ root: 'nlp', children: ['decoding', 'decoding/spec'] },
			{ root: 'x', children: ['y'] },
		]);
	});
	it('选中父标签命中子标签', () => {
		const t = task({ tags: ['nlp/decoding/spec'] });
		expect(applyTagFilter([t], { selectedTags: ['nlp'], operator: 'OR' })).toHaveLength(1);
		expect(applyTagFilter([t], { selectedTags: ['nlp/dec'], operator: 'OR' })).toHaveLength(0);
	});
	it('标签紧邻标点/零宽字符也能识别，双链锚点不误伤', () => {
		expect(extractTags('(#task) **#a/b/c** x,#d​ #e')).toEqual(['task', 'a/b/c', 'd', 'e']);
		expect(extractTags('#task 写报告 #task #Paper #paper #x')).toEqual(['task', 'Paper', 'x']);
		expect(extractTags('see [[Note#Heading]] and [[#Top]] https://x.com/#frag')).toEqual([]);
		expect(extractTaskDescription('#task **FACT** [[Note#H]]')).toBe('**FACT** [[Note#H]]');
	});
});

describe('全局筛选符作为标签', () => {
	it('Tasks 的 #task 筛选符仍计入 tags，描述中不含它', () => {
		const { parseSingleTaskLine } = jest.requireActual<typeof import('../src/tasks/taskParser/main')>('../src/tasks/taskParser/main');
		const t = parseSingleTaskLine('- [ ] #task #nlp/spec 20:00 - 21:00 **FACT** ⏳ 2026-10-19', 'a.md', 'a', 1, ['tasks', 'dataview'], '#task');
		expect(t?.tags).toEqual(['task', 'nlp/spec']);
		expect(t?.description).not.toContain('#task');
	});
});

describe('任务文字渲染', () => {
	it('行内 Markdown 分词', () => {
		const { tokenizeInlineMarkdown } = jest.requireActual<typeof import('../src/utils/inlineMarkdown')>('../src/utils/inlineMarkdown');
		expect(tokenizeInlineMarkdown('a **FACT: x** b ~~old~~ `c` *i* ==h==')).toEqual([
			{ kind: 'text', text: 'a ' }, { kind: 'bold', text: 'FACT: x' }, { kind: 'text', text: ' b ' },
			{ kind: 'strike', text: 'old' }, { kind: 'text', text: ' ' }, { kind: 'code', text: 'c' }, { kind: 'text', text: ' ' },
			{ kind: 'italic', text: 'i' }, { kind: 'text', text: ' ' }, { kind: 'mark', text: 'h' },
		]);
		expect(tokenizeInlineMarkdown('2 * 3 * 4')).toEqual([{ kind: 'text', text: '2 * 3 * 4' }]);
	});
	it('标签形式的全局筛选符不再作为文字前缀', () => {
		const { globalFilterPrefix } = jest.requireActual<typeof import('../src/utils/linkText')>('../src/utils/linkText');
		expect(globalFilterPrefix(true, '#task')).toBe('');
		expect(globalFilterPrefix(true, 'TODO')).toBe('TODO ');
		expect(globalFilterPrefix(false, 'TODO')).toBe('');
	});
});
