/**
 * @jest-environment jsdom
 */
import { act, createElement, type JSX, type MouseEvent as ReactMouseEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setIcon } from 'obsidian';
import {
	PRIORITY_ICON_MAP,
	PRIORITY_ORDER,
	getPriorityMeta,
	type PriorityLevel,
} from '../src/utils/priorityIcons';
import { buildTooltipSections } from '../src/components/tooltip/tooltipSections';
import { TooltipManager } from '../src/utils/tooltipManager';
import { SORT_OPTIONS } from '../src/tasks/taskSorter';
import { TaskCard } from '../src/ui/components/TaskCard';
import { TaskFormModal } from '../src/ui/modals/TaskFormModal';
import { TooltipProvider, useTaskTooltip } from '../src/ui/components/TooltipProvider';
import { PluginContext } from '../src/ui/pluginContext';
import { TaskViewConfig } from '../src/components/TaskCard/presets/TaskView.config';
import type { GCTask, IPluginContext } from '../src/types';

jest.mock('obsidian', () => {
	const actual = jest.requireActual<typeof import('./__mocks__/obsidian')>('./__mocks__/obsidian');
	return {
		...actual,
		normalizePath: (p: string) => p,
		setIcon: jest.fn((el: HTMLElement, icon: string) => {
			el.setAttribute('data-mock-lucide', icon);
		}),
	};
});

const PRIORITY_EMOJIS = /[🔺⏫🔼🔽⏬◽]/u;

function makeTask(priority?: string): GCTask {
	return {
		filePath: 'tasks.md',
		fileName: 'tasks.md',
		lineNumber: 1,
		content: '- [ ] sample task',
		description: 'sample task',
		completed: false,
		priority: priority ?? 'normal',
	};
}

function makePlugin(): IPluginContext {
	const pluginObj = {
		app: {
			plugins: { plugins: {} },
			workspace: {},
			vault: {},
			metadataCache: {},
		},
		settings: {
			globalTaskFilter: '',
			showGlobalFilterInTaskText: false,
			enabledTaskFormats: ['tasks'],
			taskNotePath: 'Tasks',
			taskStatuses: [],
			defaultTaskPriority: 'normal',
			timeFormat: '24h',
			taskCardClickAction: 'openFile',
			taskCardDoubleClickAction: 'editModal',
		},
		saveSettings: async () => {},
		refreshCalendarViews: () => {},
		taskCache: {
			getAllTasks: () => [] as GCTask[],
			refreshFile: async () => {},
			onUpdate: () => {},
			offUpdate: () => {},
			initialize: async () => {},
			whenReady: async () => {},
		},
	};
	return pluginObj as unknown as IPluginContext;
}

type CreateOpts = string | { cls?: string; text?: string };

/** 补齐 Obsidian 在真实 DOM / window 上挂载的辅助方法，供组件与 TooltipManager 测试使用 */
function installObsidianDomPolyfills(): () => void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	const addedProto: string[] = [];

	const defineProto = (name: string, fn: unknown) => {
		if (!(name in proto)) {
			proto[name] = fn;
			addedProto.push(name);
		}
	};

	const makeEl = (parent: HTMLElement, tag: string, clsOrOpts?: CreateOpts): HTMLElement => {
		const el = parent.ownerDocument.createElementNS('http://www.w3.org/1999/xhtml', tag);
		if (typeof clsOrOpts === 'string' && clsOrOpts) {
			el.className = clsOrOpts;
		} else if (clsOrOpts && typeof clsOrOpts === 'object') {
			if (clsOrOpts.cls) el.className = clsOrOpts.cls;
			if (clsOrOpts.text) el.textContent = clsOrOpts.text;
		}
		parent.appendChild(el);
		return el;
	};

	defineProto('createDiv', function (this: HTMLElement, clsOrOpts?: CreateOpts) {
		return makeEl(this, 'div', clsOrOpts);
	});
	defineProto('createSpan', function (this: HTMLElement, clsOrOpts?: CreateOpts) {
		return makeEl(this, 'span', clsOrOpts);
	});
	defineProto('createEl', function (this: HTMLElement, tag: string, clsOrOpts?: CreateOpts) {
		return makeEl(this, tag, clsOrOpts);
	});
	defineProto('empty', function (this: HTMLElement) {
		while (this.firstChild) this.removeChild(this.firstChild);
	});
	defineProto('setText', function (this: HTMLElement, text: string) {
		this.textContent = text;
	});
	defineProto('appendText', function (this: HTMLElement, text: string) {
		this.appendChild(this.ownerDocument.createTextNode(text));
	});
	defineProto('addClass', function (this: HTMLElement, cls: string) {
		if (cls) this.classList.add(...cls.split(/\s+/).filter(Boolean));
	});
	defineProto('removeClass', function (this: HTMLElement, cls: string) {
		if (cls) this.classList.remove(...cls.split(/\s+/).filter(Boolean));
	});
	defineProto('hasClass', function (this: HTMLElement, cls: string) {
		return cls ? this.classList.contains(cls) : false;
	});
	defineProto('setAttr', function (this: HTMLElement, name: string, value: string) {
		this.setAttribute(name, value);
	});

	const win = window as unknown as Record<string, unknown>;
	const prevEntries: Array<[string, unknown, boolean]> = [];
	const setWinProp = (name: string, val: unknown) => {
		prevEntries.push([name, win[name], name in win]);
		win[name] = val;
	};

	setWinProp('activeDocument', document);
	setWinProp('activeWindow', window);
	setWinProp('createDiv', (clsOrOpts?: CreateOpts) => makeEl(document.body, 'div', clsOrOpts));
	setWinProp('moment', () => ({ format: () => '2026-11-21' }));

	return () => {
		for (const k of addedProto) {
			delete proto[k];
		}
		for (const [k, oldVal, existed] of prevEntries) {
			if (existed) win[k] = oldVal;
			else delete win[k];
		}
	};
}

describe('priorityIcons 单一来源', () => {
	it('PRIORITY_ORDER 包含全部 6 个级别且从高到低排列', () => {
		expect(PRIORITY_ORDER).toEqual(['highest', 'high', 'medium', 'normal', 'low', 'lowest']);
	});

	it.each<[PriorityLevel, string, string]>([
		['highest', 'chevrons-up', 'var(--gc-color-red)'],
		['high', 'chevron-up', 'var(--gc-color-orange)'],
		['medium', 'equal', 'var(--gc-color-yellow)'],
		['normal', 'minus', 'var(--text-faint)'],
		['low', 'chevron-down', 'var(--gc-color-blue)'],
		['lowest', 'chevrons-down', 'var(--text-muted)'],
	])('PRIORITY_ICON_MAP[%s] 映射到 Lucide 图标 %s 与颜色令牌 %s', (level, icon, colorVar) => {
		expect(PRIORITY_ICON_MAP[level]).toEqual({ level, icon, colorVar });
		expect(getPriorityMeta(level)).toEqual({ level, icon, colorVar });
	});

	it('getPriorityMeta 支持大小写并对未知/空/原型键安全回退到 normal', () => {
		expect(getPriorityMeta('HIGH')).toEqual(PRIORITY_ICON_MAP.high);
		expect(getPriorityMeta(undefined)).toEqual(PRIORITY_ICON_MAP.normal);
		expect(getPriorityMeta(null)).toEqual(PRIORITY_ICON_MAP.normal);
		expect(getPriorityMeta('')).toEqual(PRIORITY_ICON_MAP.normal);
		expect(getPriorityMeta('urgent')).toEqual(PRIORITY_ICON_MAP.normal);
		expect(getPriorityMeta('toString')).toEqual(PRIORITY_ICON_MAP.normal);
		expect(getPriorityMeta('constructor')).toEqual(PRIORITY_ICON_MAP.normal);
	});
});

describe('tooltipSections 与 taskSorter 优先级图标集成', () => {
	it('buildTooltipSections 为非 normal 优先级输出 Lucide icon 而非 emoji', () => {
		for (const level of ['highest', 'high', 'medium', 'low', 'lowest'] as const) {
			const meta = getPriorityMeta(level);
			const sections = buildTooltipSections(makeTask(level));
			const priSection = sections.find((s) => s.key === 'priority');
			expect(priSection).toBeDefined();
			expect(priSection!.rows).toHaveLength(1);
			const row = priSection!.rows[0];
			expect(row.icon).toBe(meta.icon);
			expect(row.iconColor).toBe(meta.colorVar);
			expect(row.valueClass).toBe(`priority-${level}`);
			expect(PRIORITY_EMOJIS.test(row.value)).toBe(false);
		}
	});

	it('buildTooltipSections 对 normal 优先级省略 priority 分组', () => {
		const sections = buildTooltipSections(makeTask('normal'));
		expect(sections.find((s) => s.key === 'priority')).toBeUndefined();
	});

	it('SORT_OPTIONS 的 priority 选项使用 priorityIcons 映射', () => {
		const priOption = SORT_OPTIONS.find((o) => o.field === 'priority');
		expect(priOption?.icon).toBe(getPriorityMeta('highest').icon);
	});
});

describe('UI 组件渲染 Lucide 优先级图标（无 emoji）', () => {
	let container: HTMLDivElement;
	let root: Root;
	let cleanupDom: () => void;

	beforeAll(() => {
		if (!window.matchMedia) {
			window.matchMedia = (query: string) => ({
				matches: false,
				media: query,
				onchange: null,
				addListener: () => {},
				removeListener: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				dispatchEvent: () => false,
			});
		}
	});

	beforeEach(() => {
		jest.clearAllMocks();
		(window as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		cleanupDom = installObsidianDomPolyfills();
		while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
		container = document.body.createDiv();
		root = createRoot(container);
	});

	afterEach(async () => {
		jest.useRealTimers();
		TooltipManager.reset();
		await act(async () => {
			root.unmount();
		});
		while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
		cleanupDom();
	});

	it('TaskCard 渲染 Lucide 优先级图标与语义色类，normal 不显示徽标', async () => {
		const plugin = makePlugin();
		const config = { ...TaskViewConfig, showPriority: true, showTags: false, showTimes: false };

		for (const level of ['highest', 'high', 'medium', 'low', 'lowest'] as const) {
			const meta = getPriorityMeta(level);
			await act(async () => {
				root.render(
					createElement(
						PluginContext.Provider,
						{ value: plugin },
						createElement(
							TooltipProvider,
							null,
							createElement(TaskCard, { task: makeTask(level), config })
						)
					)
				);
			});

			const badge = container.querySelector<HTMLElement>('.gc-task-card__priority-badge');
			expect(badge).not.toBeNull();
			expect(badge!.classList.contains(`gc-task-card__priority-badge--${level}`)).toBe(true);
			expect(badge!.style.color).toBe(meta.colorVar);
			expect(badge!.getAttribute('data-mock-lucide')).toBe(meta.icon);
			expect(PRIORITY_EMOJIS.test(badge!.textContent || '')).toBe(false);
		}

		await act(async () => {
			root.render(
				createElement(
					PluginContext.Provider,
					{ value: plugin },
					createElement(
						TooltipProvider,
						null,
						createElement(TaskCard, { task: makeTask('normal'), config })
					)
				)
			);
		});
		expect(container.querySelector('.gc-task-card__priority')).toBeNull();
	});

	it('TaskFormModal 优先级分段控件按 PRIORITY_ORDER 渲染 Lucide 图标', async () => {
		const plugin = makePlugin();
		await act(async () => {
			root.render(
				createElement(
					PluginContext.Provider,
					{ value: plugin },
					createElement(TaskFormModal, {
						mode: 'create',
						app: plugin.app,
						plugin,
						onSuccess: () => {},
						onClose: () => {},
					})
				)
			);
		});

		const segments = Array.from(
			document.body.querySelectorAll<HTMLElement>('.gc-edit-task-modal__priority-segment')
		);
		expect(segments.map((el) => el.getAttribute('data-value'))).toEqual([...PRIORITY_ORDER]);

		for (const level of PRIORITY_ORDER) {
			const meta = getPriorityMeta(level);
			const btn = segments.find((el) => el.getAttribute('data-value') === level)!;
			const iconSpan = btn.querySelector<HTMLElement>('[data-mock-lucide]');
			expect(iconSpan).not.toBeNull();
			expect(iconSpan!.getAttribute('data-mock-lucide')).toBe(meta.icon);
			expect(iconSpan!.style.color).toBe(meta.colorVar);
			expect(PRIORITY_EMOJIS.test(btn.textContent || '')).toBe(false);
		}
	});

	it('TooltipManager 渲染 <span data-icon> 并调用 setIcon 注入 Lucide 图标', () => {
		const plugin = makePlugin();
		const manager = TooltipManager.getInstance(plugin, { showDelay: 0, hideDelay: 0 });

		manager.show(makeTask('highest'), container);

		const iconEl = document.body.querySelector<HTMLElement>('.gc-task-tooltip [data-icon]');
		expect(iconEl).not.toBeNull();
		expect(iconEl!.getAttribute('data-icon')).toBe('chevrons-up');
		expect(iconEl!.style.color).toBe('var(--gc-color-red)');
		expect(setIcon).toHaveBeenCalledWith(iconEl, 'chevrons-up');

		const valueEl = document.body.querySelector<HTMLElement>('.gc-task-tooltip .priority-highest');
		expect(valueEl).not.toBeNull();
		expect(PRIORITY_EMOJIS.test(valueEl!.textContent || '')).toBe(false);
	});

	it('TooltipProvider React 悬浮卡片渲染 Lucide 优先级图标（无 emoji）', async () => {
		jest.useFakeTimers();
		const plugin = makePlugin();

		function Trigger(): JSX.Element {
			const tooltip = useTaskTooltip();
			return createElement('button', {
				id: 'tt-trigger',
				onClick: (e: ReactMouseEvent<HTMLButtonElement>) => {
					tooltip.show(makeTask('high'), e.currentTarget);
				},
			}, 'hover');
		}

		await act(async () => {
			root.render(
				createElement(
					PluginContext.Provider,
					{ value: plugin },
					createElement(TooltipProvider, null, createElement(Trigger))
				)
			);
		});

		const trigger = container.querySelector<HTMLButtonElement>('#tt-trigger')!;
		await act(async () => {
			trigger.click();
			jest.advanceTimersByTime(500);
		});

		const iconWrap = document.body.querySelector<HTMLElement>('.gc-task-tooltip [data-icon="chevron-up"]');
		expect(iconWrap).not.toBeNull();
		expect(iconWrap!.style.color).toBe('var(--gc-color-orange)');
		expect(iconWrap!.querySelector('[data-mock-lucide="chevron-up"]')).not.toBeNull();

		const valueEl = document.body.querySelector<HTMLElement>('.gc-task-tooltip .priority-high');
		expect(valueEl).not.toBeNull();
		expect(PRIORITY_EMOJIS.test(valueEl!.textContent || '')).toBe(false);
	});
});
