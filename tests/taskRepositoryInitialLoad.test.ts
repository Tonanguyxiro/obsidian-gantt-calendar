/**
 * TaskRepository 首扫批量事件回归测试：
 * - initial 批量导入只维护缓存，不产生逐任务 task:created
 * - 首扫结束一次性发出 tasks:loaded
 * - 非 initial 变更保持原有逐任务事件
 */
import { EventBus } from '../src/data-layer/EventBus';
import { TaskRepository } from '../src/data-layer/TaskRepository';
import type { IDataSource } from '../src/data-layer/IDataSource';
import type { DataSourceChanges } from '../src/data-layer/types';
import type { GCTask } from '../src/types';

function makeTask(index: number, filePath = 'notes/p.md'): GCTask {
	return {
		filePath,
		fileName: 'p.md',
		lineNumber: index + 1,
		content: `- [ ] 任务${index}`,
		description: `任务${index}`,
		completed: false,
		priority: 'normal',
	};
}

function makeChanges(tasks: GCTask[]): DataSourceChanges {
	return {
		sourceId: 'markdown',
		created: tasks,
		updated: [],
		deleted: [],
	};
}

function makeSource(): { source: IDataSource; emit: (changes: DataSourceChanges, initial?: boolean) => Promise<void> } {
	let handler: ((changes: DataSourceChanges, opts?: { initial?: boolean }) => void | Promise<void>) | undefined;
	const source = {
		sourceId: 'markdown',
		sourceName: 'Markdown',
		isReadOnly: true,
		initialize: async () => {},
		getTasks: async () => [],
		onChange: (next: typeof handler) => { handler = next; },
		createTask: async () => '',
		updateTask: async () => {},
		deleteTask: async () => {},
		getSyncStatus: async () => ({
			syncDirection: 'import-only',
			conflictResolution: 'local-win',
		}),
		destroy: () => {},
	} as unknown as IDataSource;

	return {
		source,
		emit: async (changes, initial) => {
			await handler?.(changes, initial === undefined ? undefined : { initial });
		},
	};
}

describe('TaskRepository 首扫批量事件', () => {
	it('initial 变更不逐任务广播，只发出一次 tasks:loaded', async () => {
		const eventBus = new EventBus();
		const repository = new TaskRepository(eventBus);
		const { source, emit } = makeSource();
		const created = jest.fn();
		const loaded = jest.fn();
		eventBus.on('task:created', created);
		eventBus.on('tasks:loaded', loaded);

		repository.registerDataSource(source);
		await emit(makeChanges([makeTask(0), makeTask(1), makeTask(2)]), true);

		expect(created).not.toHaveBeenCalled();
		expect(loaded).toHaveBeenCalledTimes(1);
		expect(loaded).toHaveBeenCalledWith({
			sourceId: 'markdown',
			totalTasks: 3,
		});
		expect(repository.getAllTasks()).toHaveLength(3);
		expect(repository.getStats()).toEqual({
			totalTasks: 3,
			dataSources: 1,
			totalFiles: 1,
		});
		expect(repository.getTasksByFilePath('notes/p.md')).toHaveLength(3);
	});

	it('非 initial 变更保持 task:created，不发 tasks:loaded', async () => {
		const eventBus = new EventBus();
		const repository = new TaskRepository(eventBus);
		const { source, emit } = makeSource();
		const created = jest.fn();
		const loaded = jest.fn();
		eventBus.on('task:created', created);
		eventBus.on('tasks:loaded', loaded);

		repository.registerDataSource(source);
		await emit(makeChanges([makeTask(0), makeTask(1), makeTask(2)]));

		expect(created).toHaveBeenCalledTimes(3);
		expect(loaded).not.toHaveBeenCalled();
		expect(repository.getAllTasks()).toHaveLength(3);
	});
});