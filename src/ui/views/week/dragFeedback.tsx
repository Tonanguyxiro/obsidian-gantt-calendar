import { memo, useSyncExternalStore, type JSX } from 'react';
import { minutesToPx, formatMinutes } from './timelineModel';

/**
 * 拖放过程中的瞬时反馈状态（落点指示线 / 落点预览块 / 悬停列高亮 / 全天行悬停日）。
 *
 * 不放进画布组件的 useState：那样每次 dragover / pointermove 的吸附变化都会重渲染整张
 * 画布（全部日列 + 全部时间块 + 卡片）。这里是一个极小的外部 store，只有订阅了对应
 * 切片的指示层 / 列高亮组件会重渲染；变化前后等值时不通知。
 * 每个画布实例各持有一个（createDragFeedbackStore），互不干扰。
 */

export interface DropIndicator {
	/** 周内索引（单日画布恒为 0） */
	dayIndex: number;
	/** line = 外部拖入的指针吸附线（只用 startMin）；preview = 整块拖动落点预览块 */
	kind: 'line' | 'preview';
	startMin: number;
	endMin: number;
}

export interface DragFeedbackState {
	indicator: DropIndicator | null;
	/** 拖放悬停高亮的列（周内索引） */
	overCol: number | null;
	/** 全天行悬停日（周内索引） */
	alldayDay: number | null;
}

export interface DragFeedbackStore {
	get: () => DragFeedbackState;
	patch: (next: Partial<DragFeedbackState>) => void;
	reset: () => void;
	subscribe: (listener: () => void) => () => void;
}

function sameIndicator(a: DropIndicator | null, b: DropIndicator | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.dayIndex === b.dayIndex && a.kind === b.kind && a.startMin === b.startMin && a.endMin === b.endMin;
}

const EMPTY: DragFeedbackState = { indicator: null, overCol: null, alldayDay: null };

export function createDragFeedbackStore(): DragFeedbackStore {
	let state: DragFeedbackState = EMPTY;
	const listeners = new Set<() => void>();
	const patch = (next: Partial<DragFeedbackState>): void => {
		const merged: DragFeedbackState = {
			// 等值指示保留旧引用：订阅方 selector 拿到同一对象，不重渲染
			indicator: next.indicator === undefined || sameIndicator(state.indicator, next.indicator)
				? state.indicator
				: next.indicator,
			overCol: next.overCol === undefined ? state.overCol : next.overCol,
			alldayDay: next.alldayDay === undefined ? state.alldayDay : next.alldayDay,
		};
		if (merged.indicator === state.indicator && merged.overCol === state.overCol && merged.alldayDay === state.alldayDay) return;
		state = merged;
		listeners.forEach((l) => l());
	};
	return {
		get: () => state,
		patch,
		reset: () => patch(EMPTY),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
	};
}

/** 订阅反馈 store 的一个切片（selector 须返回原始值或 store 内已有的对象引用） */
export function useDragFeedback<T>(store: DragFeedbackStore, selector: (s: DragFeedbackState) => T): T {
	return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}

export interface DropIndicatorLayerProps {
	store: DragFeedbackStore;
	dayIndex: number;
	lineClass: string;
	previewClass: string;
	labelClass: string;
}

/**
 * 某一列的落点指示层：只有它随 dragover 的吸附变化重渲染，列内时间块不受影响
 */
export const DropIndicatorLayer = memo(function DropIndicatorLayer({
	store,
	dayIndex,
	lineClass,
	previewClass,
	labelClass,
}: DropIndicatorLayerProps): JSX.Element | null {
	const ind = useDragFeedback(store, (s) => (s.indicator && s.indicator.dayIndex === dayIndex ? s.indicator : null));
	if (!ind) return null;
	if (ind.kind === 'line') {
		return <div className={lineClass} style={{ top: `${minutesToPx(ind.startMin)}px` }} />;
	}
	return (
		<div
			className={previewClass}
			style={{ top: `${minutesToPx(ind.startMin)}px`, height: `${minutesToPx(ind.endMin - ind.startMin)}px` }}
		>
			<span className={labelClass}>{`${formatMinutes(ind.startMin)} – ${formatMinutes(ind.endMin)}`}</span>
		</div>
	);
});

/**
 * requestAnimationFrame 节流：一帧内多次调用只执行最后一次的参数。
 * dragover（即使指针不动也约 50ms 一次）/ pointermove（高刷屏可达 120Hz+）
 * 的布局读取（getBoundingClientRect）与状态写入合并到每帧一次。
 * flush() 立即执行挂起的调用（松手提交前对齐最后位置）；cancel() 丢弃挂起调用。
 */
export interface RafThrottled<A extends unknown[]> {
	(...args: A): void;
	flush(): void;
	cancel(): void;
}

export function rafThrottle<A extends unknown[]>(fn: (...args: A) => void): RafThrottled<A> {
	let frame = 0;
	let pending: A | null = null;
	const run = (): void => {
		frame = 0;
		const args = pending;
		pending = null;
		if (args) fn(...args);
	};
	const throttled = ((...args: A): void => {
		pending = args;
		if (!frame) frame = window.requestAnimationFrame(run);
	}) as RafThrottled<A>;
	throttled.flush = () => {
		if (frame) window.cancelAnimationFrame(frame);
		run();
	};
	throttled.cancel = () => {
		if (frame) window.cancelAnimationFrame(frame);
		frame = 0;
		pending = null;
	};
	return throttled;
}
