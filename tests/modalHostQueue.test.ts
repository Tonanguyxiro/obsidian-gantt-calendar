/** @jest-environment jsdom */
/**
 * modalHost 命令式入口的排队行为回归测试。
 *
 * 覆盖的 bug：createRoot().render() 异步调度，onload 后极短时间内调用 openReactModal
 * 时 openModalFn 尚未注册；旧实现直接 throw，异常在 React 事件里被吞 → 用户点了
 * 编辑没反应。新实现惰性 init + pending 队列 + 注册后冲刷。
 */
import { createElement } from 'react';

jest.mock('react-dom/client', () => {
	const root = { render: jest.fn(), unmount: jest.fn() };
	return { createRoot: jest.fn(() => root), __root: root };
});

jest.mock('../src/ui/components/ModalProvider', () => {
	const openModal = jest.fn((_element: unknown) => jest.fn());
	const ModalProvider = ({ children }: { children?: unknown }) => children ?? null;
	const useModal = () => ({ openModal });
	return { ModalProvider, useModal, __openModal: openModal };
});

jest.mock('../src/ui/components/TooltipProvider', () => {
	const TooltipProvider = ({ children }: { children?: unknown }) => children ?? null;
	return { TooltipProvider };
});

import {
	destroyModalHost,
	openReactModal,
	registerModalHost,
	isModalHostReady,
	getPendingModalCount,
} from '../src/ui/modals/modalHost';

const mockProvider: { __openModal: jest.Mock } = jest.requireMock('../src/ui/components/ModalProvider');
const mockClient: { createRoot: jest.Mock; __root: { render: jest.Mock; unmount: jest.Mock } } = jest.requireMock('react-dom/client');

describe('modalHost 排队 / 冲刷', () => {
	beforeAll(() => {
		// Obsidian 在真实环境注入的全局与 HTMLElement 扩展，jsdom 里补上
		(globalThis as Record<string, unknown>).activeDocument = document;
		if (!(HTMLElement.prototype as unknown as Record<string, unknown>).createDiv) {
			(HTMLElement.prototype as unknown as Record<string, unknown>).createDiv = function (
				this: HTMLElement,
				opts?: { cls?: string }
			) {
				const el = document.createElement('div');
				if (opts?.cls) el.className = opts.cls;
				this.appendChild(el);
				return el;
			};
		}
	});

	beforeEach(() => {
		jest.clearAllMocks();
		destroyModalHost();
	});

	afterEach(() => {
		destroyModalHost();
	});

	test('宿主未注册时 openReactModal 不抛错，返回函数可取消 pending', () => {
		expect(() => {
			const close = openReactModal(createElement('div', { id: 'p1' }));
			expect(typeof close).toBe('function');
			expect(getPendingModalCount()).toBe(1);
			expect(() => close()).not.toThrow();
		}).not.toThrow();
		expect(getPendingModalCount()).toBe(0);
		expect(mockProvider.__openModal).not.toHaveBeenCalled();
	});

	test('注册后自动冲刷队列，冲刷前后关闭函数都有效', () => {
		const element = createElement('div', { id: 'p2' });
		const close = openReactModal(element);
		expect(getPendingModalCount()).toBe(1);
		expect(isModalHostReady()).toBe(false);

		const realClose = jest.fn();
		mockProvider.__openModal.mockReturnValue(realClose);
		const unregister = registerModalHost(mockProvider.__openModal);

		expect(isModalHostReady()).toBe(true);
		expect(mockProvider.__openModal).toHaveBeenCalledTimes(1);
		expect((mockProvider.__openModal.mock.calls[0] as unknown[])[0]).toBe(element);
		expect(getPendingModalCount()).toBe(0);

		close();
		expect(realClose).toHaveBeenCalledTimes(1);
		unregister();
	});

	test('宿主已注册时直接打开，不入队', () => {
		const unregister = registerModalHost(mockProvider.__openModal);
		const element = createElement('div', { id: 'p3' });
		openReactModal(element);
		expect(mockProvider.__openModal).toHaveBeenCalledWith(element);
		expect(getPendingModalCount()).toBe(0);
		unregister();
	});

	test('惰性 init 只执行一次，后续打开复用同一宿主', () => {
		openReactModal(createElement('div'));
		openReactModal(createElement('div'));
		expect(mockClient.createRoot).toHaveBeenCalledTimes(1);
		expect(mockClient.__root.render).toHaveBeenCalledTimes(1);
	});

	test('重复注册 / 重复冲刷幂等，不会打开两次', () => {
		openReactModal(createElement('div', { id: 'p4' }));
		const unregisterA = registerModalHost(mockProvider.__openModal);
		const unregisterB = registerModalHost(mockProvider.__openModal);
		expect(mockProvider.__openModal).toHaveBeenCalledTimes(1);
		unregisterA();
		unregisterB();
		expect(isModalHostReady()).toBe(false);
	});

	test('destroyModalHost 清空队列并使关闭函数失效，之后能自愈重建', () => {
		const close = openReactModal(createElement('div', { id: 'p5' }));
		expect(getPendingModalCount()).toBe(1);

		destroyModalHost();
		expect(getPendingModalCount()).toBe(0);
		expect(() => close()).not.toThrow();
		expect(mockProvider.__openModal).not.toHaveBeenCalled();

		openReactModal(createElement('div', { id: 'p6' }));
		expect(getPendingModalCount()).toBe(1);
		expect(mockClient.createRoot).toHaveBeenCalledTimes(2);
	});
});
