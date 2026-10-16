import { StatusBarPresenter } from '../src/statusBar/statusBarPresenter';
import type { GCTask } from '../src/types';

function createTask(completed: boolean): GCTask {
	return {
		filePath: 'test.md',
		fileName: 'test.md',
		lineNumber: 1,
		content: '- [ ] Task',
		description: 'Task',
		completed,
		priority: 'normal',
	};
}

function createPresenter(tasks: GCTask[], status = 'ready', debounceMs = 300) {
	const element = { setText: jest.fn() };
	const getTasks = jest.fn(() => tasks);
	const getStatusParts = jest.fn(() => ({ lastSync: 'never', syncStatus: status }));
	const presenter = new StatusBarPresenter(element, getTasks, getStatusParts, { debounceMs });
	return { presenter, element, getTasks, getStatusParts };
}

describe('StatusBarPresenter', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('coalesces repeated scheduled updates into one render', () => {
		const tasks = [createTask(false)];
		const { presenter, element } = createPresenter(tasks);

		presenter.scheduleUpdate();
		presenter.scheduleUpdate();
		presenter.scheduleUpdate();
		jest.advanceTimersByTime(299);
		expect(element.setText).not.toHaveBeenCalled();

		jest.advanceTimersByTime(1);
		expect(element.setText).toHaveBeenCalledTimes(1);
		expect(element.setText).toHaveBeenCalledWith(' 1/1 | never | ready');
	});

	it('skips setText when the rendered text is unchanged', () => {
		const tasks = [createTask(false)];
		const { presenter, element } = createPresenter(tasks);

		presenter.renderNow();
		presenter.scheduleUpdate();
		jest.advanceTimersByTime(300);

		expect(element.setText).toHaveBeenCalledTimes(1);
	});

	it('reuses counts while the task array reference is unchanged', () => {
		const tasks = [createTask(true)];
		const { presenter, element } = createPresenter(tasks);

		presenter.renderNow();
		expect(element.setText).toHaveBeenLastCalledWith(' 0/1 | never | ready');

		tasks.push(createTask(false));
		presenter.renderNow();
		expect(element.setText).toHaveBeenCalledTimes(1);
	});

	it('updates text when the task array changes', () => {
		let tasks: GCTask[] = [createTask(true)];
		const { presenter, element, getTasks } = createPresenter(tasks);

		presenter.renderNow();
		expect(element.setText).toHaveBeenLastCalledWith(' 0/1 | never | ready');

		tasks = [createTask(false), createTask(false)];
		getTasks.mockImplementation(() => tasks);
		presenter.renderNow();
		expect(element.setText).toHaveBeenLastCalledWith(' 2/2 | never | ready');
	});

	it('cancels a scheduled update', () => {
		const { presenter, element } = createPresenter([]);

		presenter.scheduleUpdate();
		presenter.cancelScheduledUpdate();
		jest.advanceTimersByTime(300);

		expect(element.setText).not.toHaveBeenCalled();
	});
});
