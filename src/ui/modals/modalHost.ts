import { createElement, useEffect, type JSX, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ModalProvider, useModal, type ModalProviderContextValue } from '../components/ModalProvider';
import { TooltipProvider } from '../components/TooltipProvider';

let openModalFn: ModalProviderContextValue['openModal'] | null = null;
let hostRoot: ReturnType<typeof createRoot> | null = null;
let hostEl: HTMLElement | null = null;

/**
 * 宿主尚未注册完成时命令式打开的模态框队列。
 *
 * `createRoot().render()` 是异步调度的：onload 里 `initModalHost()` 之后极短时间内
 * （React 事件处理器、命令面板回调）调用 `openReactModal` 时，`ModalHostBridge` 的
 * useEffect 可能还没执行，`openModalFn` 仍为 null。旧实现直接 throw，异常在 React
 * 事件里被吞掉，用户看到的就是"点了编辑没反应"。现在先把元素排进队列，等桥接
 * 注册后冲刷；每个 pending 项返回给调用方的关闭函数在整个生命周期内都有效。
 */
interface PendingModal {
	element: ReactElement;
	/** 冲刷后由 openModalFn 返回的真实关闭函数 */
	realClose: (() => void) | null;
	/** 已关闭：要么取消了 pending，要么已调用 realClose */
	closed: boolean;
}

let pendingModals: PendingModal[] = [];

/** 关闭一个 pending（或已冲刷）的模态框；幂等 */
function closePendingModal(pending: PendingModal): void {
	if (pending.closed) return;
	pending.closed = true;
	if (pending.realClose) {
		pending.realClose();
		return;
	}
	// 仍在队列中：直接摘除
	pendingModals = pendingModals.filter((p) => p !== pending);
}

/**
 * 冲刷等待队列。先换出数组，避免冲刷过程中新入队的元素被本轮误处理；
 * `realClose` 已存在的项跳过，保证 React 严格模式 / 重复注册时幂等。
 */
function flushPendingModals(): void {
	const fn = openModalFn;
	if (!fn) return;
	const queue = pendingModals;
	pendingModals = [];
	for (const pending of queue) {
		if (pending.closed || pending.realClose) continue;
		pending.realClose = fn(pending.element);
		// 冲刷瞬间调用方已关闭：立刻兑现关闭，不让弹窗闪现
		if (pending.closed) pending.realClose();
	}
}

/**
 * 注册桥接函数并冲刷队列，返回注销函数。
 * 供 `ModalHostBridge` 的 useEffect 调用；也供测试直接驱动（不依赖 React 渲染时序）。
 */
export function registerModalHost(openModal: ModalProviderContextValue['openModal']): () => void {
	openModalFn = openModal;
	flushPendingModals();
	return () => {
		// 严格模式下 effect 会 cleanup→重跑；仅当仍指向本次注册才清空，
		// 避免误清后续注册（例如另一个宿主实例）
		if (openModalFn === openModal) openModalFn = null;
	};
}

/** 桥接组件：挂载后把 ModalProvider 的 openModal 注册到全局（不在 render 里 setState） */
function ModalHostBridge(): JSX.Element | null {
	const ctx = useModal();
	useEffect(() => registerModalHost(ctx.openModal), [ctx.openModal]);
	return null;
}

/**
 * 挂载全局 Modal 宿主（插件 onload 时调用一次）
 */
export function initModalHost(): void {
	if (hostRoot) return;
	hostEl = activeDocument.body.createDiv({ cls: 'gc-modal-host' });
	hostRoot = createRoot(hostEl);
	hostRoot.render(
		createElement(
			ModalProvider,
			null,
			createElement(
				TooltipProvider,
				null,
				createElement(ModalHostBridge)
			)
		)
	);
}

/**
 * 卸载全局 Modal 宿主（插件 onunload 时调用）
 */
export function destroyModalHost(): void {
	// pending 项对应的关闭函数立即失效：宿主即将卸载，绝不能再冲刷到已卸载的树
	for (const pending of pendingModals) pending.closed = true;
	pendingModals = [];
	hostRoot?.unmount();
	hostRoot = null;
	hostEl?.remove();
	hostEl = null;
	openModalFn = null;
}

/**
 * 命令式打开一个 React 模态框元素，返回关闭函数
 * 供非 React 环境（设置面板、命令、工具函数）调用。
 *
 * 宿主未就绪时不再抛错：惰性 init + 排队，桥接注册后自动冲刷。
 */
export function openReactModal(element: ReactElement): () => void {
	// 惰性初始化：即使 onload 未调用 initModalHost（测试、热重载后）也能自愈
	if (!hostRoot) initModalHost();

	if (openModalFn) return openModalFn(element);

	// 宿主还没注册（createRoot().render() 异步）：排队，返回可取消 pending 的关闭函数
	const pending: PendingModal = { element, realClose: null, closed: false };
	pendingModals.push(pending);
	return () => closePendingModal(pending);
}

/** 宿主是否已注册（测试/诊断用） */
export function isModalHostReady(): boolean {
	return openModalFn !== null;
}

/** 等待宿主注册的模态框数量（测试/诊断用） */
export function getPendingModalCount(): number {
	return pendingModals.length;
}
