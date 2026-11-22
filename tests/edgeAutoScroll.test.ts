/**
 * @jest-environment jsdom
 */
import { act, createElement, type PointerEvent as ReactPointerEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
	computeEdgeScrollVelocity,
	createEdgeAutoScroller,
	useEdgeAutoScroll,
} from '../src/ui/views/week/useEdgeAutoScroll';
import { useBlockResize } from '../src/ui/views/week/useBlockResize';
import { WeekTimelineGrid } from '../src/ui/views/week/WeekTimelineGrid';
import { DayTimelineCanvas } from '../src/ui/views/week/DayTimelineCanvas';
import type { TimeBlock, TimeBlockSegment, WeekTimelineModel, DayTimelineModel } from '../src/ui/views/week/timelineModel';
import { PluginContext } from '../src/ui/pluginContext';
import { TooltipProvider } from '../src/ui/components/TooltipProvider';
import { openCreateTaskModal } from '../src/ui/modals/TaskFormModal';
import { useCalendarStore } from '../src/ui/store/calendarStore';

jest.mock('../src/ui/modals/TaskFormModal', () => ({
	openCreateTaskModal: jest.fn(),
}));
import { DEFAULT_SETTINGS } from '../src/settings/constants';
import { WeekViewConfig, DayViewConfig } from '../src/components/TaskCard';
import { WeekViewClasses, DayCanvasClasses } from '../src/utils/bem';
import type { GCTask, IPluginContext } from '../src/types';
import type { GanttCalendarSettings } from '../src/settings/types';

function cloneSettings(): GanttCalendarSettings {
	return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as GanttCalendarSettings;
}

function makeDiv(cls?: string): HTMLDivElement {
	const el = document.createRange().createContextualFragment('<div></div>').firstElementChild as HTMLDivElement;
	if (cls) el.className = cls;
	return el;
}

function makeSpan(cls?: string): HTMLSpanElement {
	const el = document.createRange().createContextualFragment('<span></span>').firstElementChild as HTMLSpanElement;
	if (cls) el.className = cls;
	return el;
}

function installRafHarness() {
	let nextId = 1;
	const queue = new Map<number, FrameRequestCallback>();
	const origReq = window.requestAnimationFrame;
	const origCancel = window.cancelAnimationFrame;

	window.requestAnimationFrame = jest.fn((cb: FrameRequestCallback) => {
		const id = nextId++;
		queue.set(id, cb);
		return id;
	});
	window.cancelAnimationFrame = jest.fn((id: number) => {
		queue.delete(id);
	});

	const stepFrame = (time = 16) => {
		const entries = Array.from(queue.entries());
		queue.clear();
		for (const [, cb] of entries) {
			cb(time);
		}
	};

	const restore = () => {
		window.requestAnimationFrame = origReq;
		window.cancelAnimationFrame = origCancel;
	};

	return { queue, stepFrame, restore };
}

function makeMockScrollEl(opts: {
	top: number;
	bottom: number;
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	quantizeInt?: boolean;
}) {
	let _scrollTop = opts.scrollTop;
	const el = makeDiv();
	Object.defineProperty(el, 'scrollHeight', { value: opts.scrollHeight, configurable: true });
	Object.defineProperty(el, 'clientHeight', { value: opts.clientHeight, configurable: true });
	Object.defineProperty(el, 'scrollTop', {
		get: () => _scrollTop,
		set: (v: number) => {
			_scrollTop = opts.quantizeInt ? Math.trunc(v) : v;
		},
		configurable: true,
	});
	el.getBoundingClientRect = () => ({
		top: opts.top,
		bottom: opts.bottom,
		left: 0,
		right: 400,
		width: 400,
		height: opts.bottom - opts.top,
		x: 0,
		y: opts.top,
		toJSON: () => ({}),
	});
	return el;
}

function makeTask(id: number): GCTask {
	return {
		filePath: `note-${id}.md`,
		fileName: `note-${id}`,
		lineNumber: id,
		content: `- [ ] Task ${id}`,
		description: `Task ${id}`,
		completed: false,
		priority: 'normal',
		startDate: new Date(2026, 9, 19, 10, 0),
		dueDate: new Date(2026, 9, 19, 11, 0),
		datePrecision: { startDate: 'time', dueDate: 'time' },
	};
}

function makePlugin(): IPluginContext {
	return {
		app: {} as IPluginContext['app'],
		settings: cloneSettings(),
		saveSettings: async () => {},
		refreshCalendarViews: () => {},
		taskCache: {
			getAllTasks: () => [],
			refreshFile: async () => {},
			onUpdate: () => {},
			offUpdate: () => {},
			initialize: async () => {},
			whenReady: async () => {},
		},
	};
}

describe('computeEdgeScrollVelocity', () => {
	const topEdge = 100;
	const bottomEdge = 700;

	test('在 40px 边界内外返回准确的线性速度与 0', () => {
		expect(computeEdgeScrollVelocity(140, topEdge, bottomEdge)).toBe(0);
		expect(computeEdgeScrollVelocity(660, topEdge, bottomEdge)).toBe(0);
		expect(computeEdgeScrollVelocity(400, topEdge, bottomEdge)).toBe(0);

		// 上 40px 触发区：越靠近上边界越快（负值）
		expect(computeEdgeScrollVelocity(139, topEdge, bottomEdge)).toBeCloseTo(-0.35, 5);
		expect(computeEdgeScrollVelocity(120, topEdge, bottomEdge)).toBeCloseTo(-7, 5);
		expect(computeEdgeScrollVelocity(100, topEdge, bottomEdge)).toBe(-14);
		expect(computeEdgeScrollVelocity(60, topEdge, bottomEdge)).toBe(-14);

		// 下 40px 触发区：越靠近下边界越快（正值）
		expect(computeEdgeScrollVelocity(661, topEdge, bottomEdge)).toBeCloseTo(0.35, 5);
		expect(computeEdgeScrollVelocity(680, topEdge, bottomEdge)).toBeCloseTo(7, 5);
		expect(computeEdgeScrollVelocity(700, topEdge, bottomEdge)).toBe(14);
		expect(computeEdgeScrollVelocity(750, topEdge, bottomEdge)).toBe(14);
	});

	test('支持极矮容器与异常参数边界保护', () => {
		// 容器高 60px 时，有效触发区缩至 30px，中点为 0
		expect(computeEdgeScrollVelocity(130, 100, 160, 40, 14)).toBe(0);
		expect(computeEdgeScrollVelocity(115, 100, 160, 40, 14)).toBeCloseTo(-7, 5);
		expect(computeEdgeScrollVelocity(145, 100, 160, 40, 14)).toBeCloseTo(7, 5);

		// 无效参数
		expect(computeEdgeScrollVelocity(100, 200, 200)).toBe(0);
		expect(computeEdgeScrollVelocity(100, 300, 200)).toBe(0);
		expect(computeEdgeScrollVelocity(Number.NaN, 100, 500)).toBe(0);
		expect(computeEdgeScrollVelocity(110, 100, 500, 0, 14)).toBe(0);
		expect(computeEdgeScrollVelocity(110, 100, 500, 40, 0)).toBe(0);
	});
});

describe('createEdgeAutoScroller', () => {
	let raf: ReturnType<typeof installRafHarness>;

	beforeEach(() => {
		raf = installRafHarness();
	});

	afterEach(() => {
		raf.restore();
	});

	test('支持 sticky topInset、rAF 启动/逐帧推进/离开停转与 stop()', () => {
		const scrollEl = makeMockScrollEl({
			top: 100,
			bottom: 600,
			scrollTop: 300,
			scrollHeight: 1200,
			clientHeight: 500,
		});
		const onScroll = jest.fn();
		const scroller = createEdgeAutoScroller({
			getScrollContainer: () => scrollEl,
			getTopInset: () => 80, // 有效上边缘 = 100 + 80 = 180
			onScroll,
		});

		// 225 > 180 + 40 -> 不在触发区
		scroller.update(225);
		expect(scroller.isActive()).toBe(false);
		expect(raf.queue.size).toBe(0);

		// 200 落在 [180, 220) 的正中间 -> 速度 -7px/frame
		scroller.update(200);
		expect(scroller.isActive()).toBe(true);
		raf.stepFrame();
		expect(scrollEl.scrollTop).toBeCloseTo(293, 5);
		expect(onScroll).toHaveBeenCalledTimes(1);

		raf.stepFrame();
		expect(scrollEl.scrollTop).toBeCloseTo(286, 5);
		expect(onScroll).toHaveBeenCalledTimes(2);

		// 移回安全区 -> 立即 cancel rAF
		scroller.update(350);
		expect(scroller.isActive()).toBe(false);
		expect(raf.queue.size).toBe(0);

		// 下边缘中点 (600 - 20 = 580) -> +7px/frame
		scroller.update(580);
		expect(scroller.isActive()).toBe(true);
		raf.stepFrame();
		expect(scrollEl.scrollTop).toBeCloseTo(293, 5);
		expect(onScroll).toHaveBeenCalledTimes(3);

		// stop() 取消挂起帧
		scroller.stop();
		expect(scroller.isActive()).toBe(false);
		expect(raf.queue.size).toBe(0);
	});

	test('滚动到达上下边界时严格钳制并停止空转', () => {
		const scrollEl = makeMockScrollEl({
			top: 0,
			bottom: 500,
			scrollTop: 10,
			scrollHeight: 1200,
			clientHeight: 500, // maxScrollTop = 700
		});
		const onScroll = jest.fn();
		const scroller = createEdgeAutoScroller({
			getScrollContainer: () => scrollEl,
			onScroll,
		});

		// 顶部边界钳制：10 -> 0
		scroller.update(0); // -14px/frame
		expect(scroller.isActive()).toBe(true);
		raf.stepFrame();
		expect(scrollEl.scrollTop).toBe(0);
		expect(onScroll).toHaveBeenCalledTimes(1);
		// 触顶后停止调度下一帧
		expect(scroller.isActive()).toBe(false);

		// 已在顶部继续向上更新也不调度
		scroller.update(0);
		expect(scroller.isActive()).toBe(false);

		// 底部边界钳制：695 -> 700
		scrollEl.scrollTop = 695;
		scroller.update(500); // +14px/frame
		expect(scroller.isActive()).toBe(true);
		raf.stepFrame();
		expect(scrollEl.scrollTop).toBe(700);
		expect(onScroll).toHaveBeenCalledTimes(2);
		expect(scroller.isActive()).toBe(false);
	});

	test('容器对 scrollTop 取整时通过余数累计支持低速边缘滚动', () => {
		const scrollEl = makeMockScrollEl({
			top: 0,
			bottom: 500,
			scrollTop: 100,
			scrollHeight: 1200,
			clientHeight: 500,
			quantizeInt: true,
		});
		const onScroll = jest.fn();
		const scroller = createEdgeAutoScroller({
			getScrollContainer: () => scrollEl,
			onScroll,
		});

		// 462 -> ratio = 2/40 = 0.05 -> velocity = 0.7 px/frame
		scroller.update(462);
		raf.stepFrame(); // 100.7 -> trunc 100, remainder 0.7
		expect(scrollEl.scrollTop).toBe(100);
		expect(onScroll).not.toHaveBeenCalled();

		raf.stepFrame(); // 100 + 0.7 + 0.7 = 101.4 -> trunc 101, fired!
		expect(scrollEl.scrollTop).toBe(101);
		expect(onScroll).toHaveBeenCalledTimes(1);
		scroller.stop();
	});
});

describe('组件与 Hook 集成：useEdgeAutoScroll / useBlockResize / WeekTimelineGrid / DayTimelineCanvas', () => {
	let container: HTMLDivElement;
	let root: Root;
	let raf: ReturnType<typeof installRafHarness>;

	beforeEach(() => {
		(window as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		(window as unknown as { activeDocument?: Document }).activeDocument = document;
		useCalendarStore.getState().syncSettings(cloneSettings());
		container = makeDiv();
		document.body.appendChild(container);
		root = createRoot(container);
		raf = installRafHarness();
		if (!HTMLElement.prototype.createDiv) {
			(HTMLElement.prototype as unknown as { createDiv: (this: HTMLElement, options?: { cls?: string }) => HTMLDivElement }).createDiv = function createDiv(this: HTMLElement, options?: { cls?: string }) {
				const d = makeDiv(options?.cls);
				this.appendChild(d);
				return d;
			};
		}
		if (!document.createDiv) {
			(document as unknown as { createDiv?: (cls?: string) => HTMLDivElement }).createDiv = (cls?: string) => makeDiv(cls);
		}
		if (!(window as unknown as { createDiv?: (cls?: string) => HTMLDivElement }).createDiv) {
			(window as unknown as { createDiv?: (cls?: string) => HTMLDivElement }).createDiv = (cls?: string) => makeDiv(cls);
		}
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		raf.restore();
	});

	test('useEdgeAutoScroll 在组件卸载时自动停止挂起的 rAF 循环', async () => {
		const scrollEl = makeMockScrollEl({
			top: 0,
			bottom: 500,
			scrollTop: 200,
			scrollHeight: 1200,
			clientHeight: 500,
		});
		let scrollerApi: ReturnType<typeof useEdgeAutoScroll> | null = null;
		function Harness() {
			scrollerApi = useEdgeAutoScroll({ getScrollContainer: () => scrollEl });
			return null;
		}
		await act(async () => {
			root.render(createElement(Harness));
		});
		scrollerApi!.update(490);
		expect(scrollerApi!.isActive()).toBe(true);

		await act(async () => {
			root.unmount();
		});
		expect(scrollerApi!.isActive()).toBe(false);
		expect(raf.queue.size).toBe(0);
	});

	test('useBlockResize 在底边 40px 拖拽时自动滚动并在鼠标静止时同步刷新块预览，松手停止', async () => {
		const scrollEl = makeMockScrollEl({
			top: 100,
			bottom: 600,
			scrollTop: 200,
			scrollHeight: 1200,
			clientHeight: 500,
		});
		const colEl = makeDiv();
		colEl.getBoundingClientRect = () => ({
			top: 100 - scrollEl.scrollTop,
			bottom: 1300 - scrollEl.scrollTop,
			left: 0,
			right: 100,
			width: 100,
			height: 1200,
			x: 0,
			y: 100 - scrollEl.scrollTop,
			toJSON: () => ({}),
		});
		const blockEl = makeDiv();
		const labelEl = makeSpan(WeekViewClasses.elements.timeBlockTime);
		blockEl.appendChild(labelEl);

		const task = makeTask(1);
		const seg: TimeBlockSegment = {
			dayIndex: 0,
			startMin: 600,
			endMin: 660,
			continuesBefore: false,
			continuesAfter: false,
			lane: 0,
			laneCount: 1,
			stackedIndex: 0,
		};
		const block: TimeBlock = {
			task,
			start: new Date(2026, 9, 19, 10, 0),
			end: new Date(2026, 9, 19, 11, 0),
			isPoint: false,
			pointField: 'dueDate',
			segments: [seg],
		};

		const onCommit = jest.fn();
		let beginResize!: ReturnType<typeof useBlockResize>;
		function ResizeHarness() {
			beginResize = useBlockResize(onCommit, { getScrollContainer: () => scrollEl });
			return null;
		}
		await act(async () => {
			root.render(createElement(ResizeHarness));
		});

		const startEv = {
			button: 0,
			clientX: 50,
			clientY: 450,
			altKey: false,
			preventDefault: jest.fn(),
			stopPropagation: jest.fn(),
		} as unknown as ReactPointerEvent;
		expect(beginResize(startEv, block, seg, 'bottom', colEl, blockEl)).toBe(true);

		// 移动指针至容器下缘（clientY = 600 -> +14px/frame）
		document.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 600 }));
		// 推进帧：rafThrottle + autoScroller tick
		raf.stepFrame();
		expect(scrollEl.scrollTop).toBe(214);
		const heightAfterScroll1 = parseFloat(blockEl.style.height);

		// 指针不动再推 1 帧：滚动到 228，块高继续增加且 label 同步更新
		raf.stepFrame();
		expect(scrollEl.scrollTop).toBe(228);
		const heightAfterScroll2 = parseFloat(blockEl.style.height);
		expect(heightAfterScroll2).toBeGreaterThan(heightAfterScroll1);
		expect(labelEl.textContent).toContain('10:00');

		// pointerup 停止自动滚动并提交
		document.dispatchEvent(new MouseEvent('pointerup', { clientX: 50, clientY: 600 }));
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(raf.queue.size).toBe(0);
	});

	test('WeekTimelineGrid HTML5 dragover 命中底边 40px 滚动并更新指示预览，dragleave 停止', async () => {
		const plugin = makePlugin();
		const weekStart = new Date(2026, 9, 19);
		const days = Array.from({ length: 7 }, (_, i) => {
			const d = new Date(weekStart);
			d.setDate(d.getDate() + i);
			return { date: d, isToday: i === 0, weekday: (i + 1) % 7, day: d.getDate() };
		});
		const model: WeekTimelineModel = {
			days: Array.from({ length: 7 }, () => []),
			blocks: [],
			allday: [],
		};

		await act(async () => {
			root.render(
				createElement(
					PluginContext.Provider,
					{ value: plugin },
					createElement(
						TooltipProvider,
						null,
						createElement(WeekTimelineGrid, {
							days,
							dayNames: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
							weekStart,
							model,
							tasks: [],
							config: { ...WeekViewConfig, variant: 'timeline' },
							showLunar: false,
							refreshTasks: () => {},
							updateSeq: 0,
						}),
					),
				),
			);
		});

		const grid = container.querySelector(`.${WeekViewClasses.elements.tasksGrid}`) as HTMLElement;
		const alldayRow = container.querySelector(`.${WeekViewClasses.elements.alldayRow}`) as HTMLElement;
		const col0 = container.querySelector(`.${WeekViewClasses.elements.dayCol}[data-day-idx="0"]`) as HTMLElement;

		let _scrollTop = 100;
		Object.defineProperty(grid, 'scrollHeight', { value: 1280, configurable: true });
		Object.defineProperty(grid, 'clientHeight', { value: 500, configurable: true });
		Object.defineProperty(grid, 'scrollTop', {
			get: () => _scrollTop,
			set: (v: number) => { _scrollTop = v; },
			configurable: true,
		});
		grid.getBoundingClientRect = () => ({
			top: 0, bottom: 500, left: 0, right: 800, width: 800, height: 500, x: 0, y: 0, toJSON: () => ({}),
		});
		alldayRow.getBoundingClientRect = () => ({
			top: 52, bottom: 80, left: 48, right: 800, width: 752, height: 28, x: 48, y: 52, toJSON: () => ({}),
		});
		col0.getBoundingClientRect = () => ({
			top: 80 - _scrollTop, bottom: 1280 - _scrollTop, left: 48, right: 150, width: 102, height: 1200, x: 48, y: 80 - _scrollTop, toJSON: () => ({}),
		});

		// 在 col0 底部 40px 区域触发 dragover（clientY = 500）
		await act(async () => {
			const dragOverEv = new Event('dragover', { bubbles: true, cancelable: true }) as unknown as DragEvent;
			Object.defineProperty(dragOverEv, 'clientY', { value: 500 });
			Object.defineProperty(dragOverEv, 'dataTransfer', { value: { dropEffect: 'none' } });
			col0.dispatchEvent(dragOverEv);
		});

		await act(async () => {
			raf.stepFrame();
		});
		expect(_scrollTop).toBe(114);
		const dropLine1 = col0.querySelector<HTMLElement>(`.${WeekViewClasses.elements.dropLine}`);
		expect(dropLine1).not.toBeNull();
		const top1 = parseFloat(dropLine1!.style.top);

		// 鼠标不动继续下一帧，网格继续滚动且落点线向后移动
		await act(async () => {
			raf.stepFrame();
		});
		expect(_scrollTop).toBe(128);
		const dropLine2 = col0.querySelector<HTMLElement>(`.${WeekViewClasses.elements.dropLine}`);
		expect(dropLine2).not.toBeNull();
		const top2 = parseFloat(dropLine2!.style.top);
		expect(top2).toBeGreaterThan(top1);

		// sticky topInset（80px）处向上拖动：clientY = 90 落在 [80, 120) 内应向上滚
		await act(async () => {
			const dragOverUp = new Event('dragover', { bubbles: true, cancelable: true }) as unknown as DragEvent;
			Object.defineProperty(dragOverUp, 'clientY', { value: 90 });
			Object.defineProperty(dragOverUp, 'dataTransfer', { value: { dropEffect: 'none' } });
			col0.dispatchEvent(dragOverUp);
			raf.stepFrame();
		});
		expect(_scrollTop).toBeLessThan(128);

		// dragleave 离开整个 grid 后停止自动滚动
		await act(async () => {
			const dragLeave = new Event('dragleave', { bubbles: true });
			Object.defineProperty(dragLeave, 'relatedTarget', { value: document.body });
			grid.dispatchEvent(dragLeave);
		});
		expect(raf.queue.size).toBe(0);
	});

	test('DayTimelineCanvas 解析 .gc-day-canvas__body 并在 pointer 拖拽创建靠近底边时自动滚动', async () => {
		const plugin = makePlugin();
		const day = new Date(2026, 9, 19);
		const model: DayTimelineModel = { blocks: [], allday: [] };

		(openCreateTaskModal as jest.Mock).mockClear();
		await act(async () => {
			root.render(
				createElement(
					PluginContext.Provider,
					{ value: plugin },
					createElement(
						TooltipProvider,
						null,
						createElement(DayTimelineCanvas, {
							day,
							model,
							config: { ...DayViewConfig, variant: 'timeline' },
							tasks: [],
							refresh: () => {},
						}),
					),
				),
			);
		});

		const body = container.querySelector(`.${DayCanvasClasses.elements.body}`) as HTMLElement;
		const canvas = container.querySelector(`.${DayCanvasClasses.elements.canvas}`) as HTMLElement;
		let _scrollTop = 100;
		Object.defineProperty(body, 'scrollHeight', { value: 1200, configurable: true });
		Object.defineProperty(body, 'clientHeight', { value: 400, configurable: true });
		Object.defineProperty(body, 'scrollTop', {
			get: () => _scrollTop,
			set: (v: number) => { _scrollTop = v; },
			configurable: true,
		});
		body.getBoundingClientRect = () => ({
			top: 0, bottom: 400, left: 0, right: 360, width: 360, height: 400, x: 0, y: 0, toJSON: () => ({}),
		});
		canvas.getBoundingClientRect = () => ({
			top: -_scrollTop, bottom: 1200 - _scrollTop, left: 44, right: 360, width: 316, height: 1200, x: 44, y: -_scrollTop, toJSON: () => ({}),
		});

		// 在画布上按下左键发起选区创建，然后移至底边 40px（clientY = 400）
		await act(async () => {
			const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 120, clientY: 200 });
			canvas.dispatchEvent(down);
			document.dispatchEvent(new MouseEvent('pointermove', { clientX: 120, clientY: 400 }));
			raf.stepFrame();
		});
		expect(_scrollTop).toBe(114);
		const ghost = canvas.querySelector(`.${DayCanvasClasses.elements.ghost}`) as HTMLElement;
		const h1 = parseFloat(ghost.style.height);

		await act(async () => {
			raf.stepFrame();
		});
		expect(_scrollTop).toBe(128);
		expect(parseFloat(ghost.style.height)).toBeGreaterThan(h1);

		await act(async () => {
			document.dispatchEvent(new MouseEvent('pointerup', { clientX: 120, clientY: 400 }));
		});
		expect(raf.queue.size).toBe(0);
		expect(openCreateTaskModal).toHaveBeenCalledTimes(1);
	});

	test('DayTimelineCanvas 在侧栏容器中自动向上查找 .gc-sidebar__panel-body 并在 HTML5 dragover 时自动滚动', async () => {
		const plugin = makePlugin();
		const day = new Date(2026, 9, 19);
		const model: DayTimelineModel = { blocks: [], allday: [] };

		const sidebarScrollEl = makeDiv('gc-sidebar__panel-body');
		let _scrollTop = 100;
		Object.defineProperty(sidebarScrollEl, 'scrollHeight', { value: 1200, configurable: true });
		Object.defineProperty(sidebarScrollEl, 'clientHeight', { value: 400, configurable: true });
		Object.defineProperty(sidebarScrollEl, 'scrollTop', {
			get: () => _scrollTop,
			set: (v: number) => { _scrollTop = v; },
			configurable: true,
		});
		sidebarScrollEl.getBoundingClientRect = () => ({
			top: 50, bottom: 450, left: 0, right: 280, width: 280, height: 400, x: 0, y: 50, toJSON: () => ({}),
		});
		container.appendChild(sidebarScrollEl);
		const sidebarRoot = createRoot(sidebarScrollEl);

		await act(async () => {
			sidebarRoot.render(
				createElement(
					PluginContext.Provider,
					{ value: plugin },
					createElement(
						TooltipProvider,
						null,
						createElement(DayTimelineCanvas, {
							day,
							model,
							config: { ...DayViewConfig, variant: 'timeline' },
							tasks: [],
							refresh: () => {},
						}),
					),
				),
			);
		});

		const canvas = sidebarScrollEl.querySelector(`.${DayCanvasClasses.elements.canvas}`) as HTMLElement;
		canvas.getBoundingClientRect = () => ({
			top: 50 - _scrollTop, bottom: 1250 - _scrollTop, left: 44, right: 280, width: 236, height: 1200, x: 44, y: 50 - _scrollTop, toJSON: () => ({}),
		});

		// dragover 靠近底边（clientY = 450）
		await act(async () => {
			const dragOverEv = new Event('dragover', { bubbles: true, cancelable: true }) as unknown as DragEvent;
			Object.defineProperty(dragOverEv, 'clientY', { value: 450 });
			Object.defineProperty(dragOverEv, 'dataTransfer', { value: { dropEffect: 'none' } });
			canvas.dispatchEvent(dragOverEv);
			raf.stepFrame();
		});
		expect(_scrollTop).toBe(114);

		// document dragend 停止自动滚动
		await act(async () => {
			document.dispatchEvent(new Event('dragend', { bubbles: true }));
		});
		expect(raf.queue.size).toBe(0);

		await act(async () => {
			sidebarRoot.unmount();
		});
	});
});
