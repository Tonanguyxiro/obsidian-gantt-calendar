import { useEffect, useMemo, useRef } from 'react';

/** 默认边缘自动滚动触发区高度（px） */
export const DEFAULT_EDGE_ZONE_PX = 40;

/** 默认每帧最大自动滚动速度（px/frame） */
export const DEFAULT_MAX_SCROLL_SPEED_PX = 14;

/**
 * 计算拖拽/调整大小指针靠近滚动容器上下边缘时的线性滚动速度（px/frame）：
 * - 上边缘 `[topEdge, topEdge + zonePx)`：由 `topEdge + zonePx` 处的 `0` 线性增至 `<= topEdge` 处的 `-maxSpeedPx`
 * - 下边缘 `(bottomEdge - zonePx, bottomEdge]`：由 `bottomEdge - zonePx` 处的 `0` 线性增至 `>= bottomEdge` 处的 `+maxSpeedPx`
 * - 其余区域或非法矩形：返回 `0`
 */
export function computeEdgeScrollVelocity(
	pointerY: number,
	topEdge: number,
	bottomEdge: number,
	zonePx: number = DEFAULT_EDGE_ZONE_PX,
	maxSpeedPx: number = DEFAULT_MAX_SCROLL_SPEED_PX,
): number {
	if (!Number.isFinite(pointerY) || !Number.isFinite(topEdge) || !Number.isFinite(bottomEdge)) {
		return 0;
	}
	if (!Number.isFinite(zonePx) || !Number.isFinite(maxSpeedPx) || zonePx <= 0 || maxSpeedPx <= 0) {
		return 0;
	}
	const span = bottomEdge - topEdge;
	if (span <= 0) return 0;

	const effectiveZone = Math.min(zonePx, span / 2);
	const topBoundary = topEdge + effectiveZone;
	const bottomBoundary = bottomEdge - effectiveZone;

	if (pointerY < topBoundary) {
		const ratio = Math.min(1, (topBoundary - pointerY) / effectiveZone);
		return -ratio * maxSpeedPx;
	}
	if (pointerY > bottomBoundary) {
		const ratio = Math.min(1, (pointerY - bottomBoundary) / effectiveZone);
		return ratio * maxSpeedPx;
	}
	return 0;
}

export interface EdgeAutoScrollOptions {
	/** 获取纵向滚动容器（无则返回 null） */
	getScrollContainer: () => HTMLElement | null;
	/** 滚动容器顶部的 sticky 遮挡高度（px，例如周视图的表头 + 全天行高度），默认 0 */
	getTopInset?: () => number;
	/** 边缘触发带高度（px），默认 40 */
	zonePx?: number;
	/** 最大速度（px/frame），默认 14 */
	maxSpeedPx?: number;
	/** scrollTop 实际发生变化后触发，用于在鼠标静止时同步更新拖拽/resize 预览 */
	onScroll?: () => void;
}

export interface EdgeAutoScroller {
	/** 依据指针 clientY 更新边缘滚动速度并按需启动/停止 rAF 循环 */
	update: (clientY: number) => void;
	/** 立即取消挂起的 rAF 并清空状态 */
	stop: () => void;
	/** 当前是否有 rAF 自动滚动循环正在运行 */
	isActive: () => boolean;
}

/**
 * 创建基于 `requestAnimationFrame` 的边缘自动滚动控制器：
 * 在靠近滚动容器上下 40px 边缘时以线性速度持续滚动，并将滚动边界钳制在
 * `[0, scrollHeight - clientHeight]`，避免触顶/触底后空转或越界。
 */
export function createEdgeAutoScroller(options: EdgeAutoScrollOptions): EdgeAutoScroller {
	let rafId: number | null = null;
	let lastClientY: number | null = null;
	let remainder = 0;

	const evaluate = (clientY: number): { scrollEl: HTMLElement; velocity: number } | null => {
		const scrollEl = options.getScrollContainer();
		if (!scrollEl) return null;
		const rect = scrollEl.getBoundingClientRect();
		const rawInset = options.getTopInset ? options.getTopInset() : 0;
		const topInset = Number.isFinite(rawInset) && rawInset > 0 ? rawInset : 0;
		const velocity = computeEdgeScrollVelocity(
			clientY,
			rect.top + topInset,
			rect.bottom,
			options.zonePx ?? DEFAULT_EDGE_ZONE_PX,
			options.maxSpeedPx ?? DEFAULT_MAX_SCROLL_SPEED_PX,
		);
		return { scrollEl, velocity };
	};

	const stop = (): void => {
		if (rafId !== null) {
			window.cancelAnimationFrame(rafId);
			rafId = null;
		}
		lastClientY = null;
		remainder = 0;
	};

	const tick = (): void => {
		rafId = null;
		if (lastClientY === null) return;
		const evaluated = evaluate(lastClientY);
		if (!evaluated || evaluated.velocity === 0) {
			remainder = 0;
			return;
		}

		const { scrollEl, velocity } = evaluated;
		const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
		const prevScrollTop = scrollEl.scrollTop;
		const desired = prevScrollTop + velocity + remainder;
		const clamped = Math.max(0, Math.min(maxScrollTop, desired));

		scrollEl.scrollTop = clamped;
		const actual = scrollEl.scrollTop;
		const hitTopBoundary = velocity < 0 && actual <= 0;
		const hitBottomBoundary = velocity > 0 && actual >= maxScrollTop;
		remainder = hitTopBoundary || hitBottomBoundary ? 0 : desired - actual;

		if (actual !== prevScrollTop) {
			options.onScroll?.();
		}
		if (hitTopBoundary || hitBottomBoundary) {
			return;
		}
		if (lastClientY !== null && rafId === null) {
			rafId = window.requestAnimationFrame(tick);
		}
	};

	const update = (clientY: number): void => {
		lastClientY = clientY;
		const evaluated = evaluate(clientY);
		if (!evaluated || evaluated.velocity === 0) {
			stop();
			return;
		}
		const { scrollEl, velocity } = evaluated;
		const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
		if ((velocity < 0 && scrollEl.scrollTop <= 0) || (velocity > 0 && scrollEl.scrollTop >= maxScrollTop)) {
			if (rafId !== null) {
				window.cancelAnimationFrame(rafId);
				rafId = null;
			}
			remainder = 0;
			return;
		}
		if (rafId === null) {
			rafId = window.requestAnimationFrame(tick);
		}
	};

	return {
		update,
		stop,
		isActive: () => rafId !== null,
	};
}

/**
 * React Hook 封装：保持稳定 scroller 引用，并在组件卸载时自动停止 rAF 循环。
 */
export function useEdgeAutoScroll(options: EdgeAutoScrollOptions): EdgeAutoScroller {
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const scroller = useMemo(
		() =>
			createEdgeAutoScroller({
				getScrollContainer: () => optionsRef.current.getScrollContainer(),
				getTopInset: () => optionsRef.current.getTopInset?.() ?? 0,
				zonePx: options.zonePx,
				maxSpeedPx: options.maxSpeedPx,
				onScroll: () => optionsRef.current.onScroll?.(),
			}),
		[options.zonePx, options.maxSpeedPx],
	);

	useEffect(() => () => scroller.stop(), [scroller]);

	return scroller;
}
