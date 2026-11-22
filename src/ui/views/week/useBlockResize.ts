import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { TimeBlock, TimeBlockSegment } from './timelineModel';
import { MIN_DURATION_MIN, minutesToPx, pxToMinutes, snapMinutes, formatMinutes } from './timelineModel';
import { WeekViewClasses, setCssProps } from '../../../utils/bem';
import { rafThrottle, type RafThrottled } from './dragFeedback';
import { useEdgeAutoScroll } from './useEdgeAutoScroll';

/**
 * 时间块上下边缘 resize 鼠标状态机（参考甘特 taskDragController 模式）：
 * - mousedown 捕获（stopPropagation，避免触发卡片 HTML5 拖源）
 * - pointermove 以 15 分钟吸附（Alt = 5 分钟），钳制在本列 [00:00, 24:00]
 * - 预览走乐观 DOM 更新（block 的 top/height + 时刻标签 + 悬浮气泡），不触发 React 重渲染
 * - pointerup 提交；未产生时间变化不写回，提交失败由调用方用 blockEl 还原样式
 *
 * 监听器闭包存于 ref，add/remove 始终匹配同一引用，无泄漏。
 */
export interface BlockResizeCommit {
	(
		block: TimeBlock,
		seg: TimeBlockSegment,
		edge: 'top' | 'bottom',
		newStartMin: number,
		newEndMin: number,
		blockEl: HTMLElement,
	): void;
}

interface ActiveResize {
	block: TimeBlock;
	seg: TimeBlockSegment;
	edge: 'top' | 'bottom';
	columnEl: HTMLElement;
	blockEl: HTMLElement;
	newStartMin: number;
	newEndMin: number;
	changed: boolean;
	tipEl: HTMLElement;
}

interface DragHandlers {
	move: (e: PointerEvent) => void;
	end: (e: PointerEvent) => void;
	cancel: () => void;
	/** 按帧合并的预览更新（布局读取 + 样式写入每帧至多一次） */
	frame: RafThrottled<[number, number, boolean]>;
}

export interface UseBlockResizeOptions {
	/** 获取纵向滚动容器（拖拽边缘自动滚动用） */
	getScrollContainer?: () => HTMLElement | null;
	/** 滚动容器顶部 sticky 遮挡高度（px） */
	getTopInset?: () => number;
	zonePx?: number;
	maxSpeedPx?: number;
}

/**
 * resize 手势进行中的模块级标志。
 * 手柄 mousedown 已 stopPropagation，列内 hover 逻辑无法从事件流感知——
 * 直接导出探测函数（与 isContextMenuOpen 同模式），拖边缘期间不出"+ 可添加"ghost
 */
let resizeActive = false;

/** 是否有块边缘 resize 手势正在进行 */
export function isBlockResizing(): boolean {
	return resizeActive;
}

/**
 * 整块拖动的抓取信息（跨视图共享的模块级状态：周视图与侧栏每日时间线）。
 * dragover 阶段 dataTransfer.getData 不可用（只能读 types），落点预览与
 * 边缘锚定所需的偏移/时长存在这里；dragend / drop 清零
 */
export interface BlockDragMeta {
	/** 抓取点相对块顶边的像素偏移（落点 = 指针 - 偏移 = 块上边缘） */
	offsetPx: number;
	/** 任务时长（分钟），落点预览高度与后向点任务锚点计算用 */
	durationMin: number;
}

let blockDragMeta: BlockDragMeta | null = null;

export function setBlockDragMeta(meta: BlockDragMeta): void {
	blockDragMeta = meta;
}

export function getBlockDragMeta(): BlockDragMeta | null {
	return blockDragMeta;
}

export function clearBlockDragMeta(): void {
	blockDragMeta = null;
}

export function useBlockResize(onCommit: BlockResizeCommit, scrollOptions?: UseBlockResizeOptions) {
	const activeRef = useRef<ActiveResize | null>(null);
	const handlersRef = useRef<DragHandlers | null>(null);
	const commitRef = useRef(onCommit);
	commitRef.current = onCommit;
	const scrollOptionsRef = useRef(scrollOptions);
	scrollOptionsRef.current = scrollOptions;
	const lastPointerRef = useRef<{ clientX: number; clientY: number; altKey: boolean } | null>(null);
	const applyPreviewRef = useRef<((clientX: number, clientY: number, altKey: boolean) => void) | null>(null);

	const autoScroller = useEdgeAutoScroll({
		getScrollContainer: () => scrollOptionsRef.current?.getScrollContainer?.() ?? null,
		getTopInset: () => scrollOptionsRef.current?.getTopInset?.() ?? 0,
		zonePx: scrollOptions?.zonePx,
		maxSpeedPx: scrollOptions?.maxSpeedPx,
		onScroll: () => {
			const ptr = lastPointerRef.current;
			if (ptr && applyPreviewRef.current) {
				applyPreviewRef.current(ptr.clientX, ptr.clientY, ptr.altKey);
			}
		},
	});

	const detach = useCallback(() => {
		autoScroller.stop();
		applyPreviewRef.current = null;
		lastPointerRef.current = null;
		const handlers = handlersRef.current;
		if (handlers) {
			handlers.frame.cancel();
			document.removeEventListener('pointermove', handlers.move);
			document.removeEventListener('pointerup', handlers.end);
			document.removeEventListener('pointercancel', handlers.cancel);
			handlersRef.current = null;
		}
		if (activeRef.current) {
			activeRef.current.tipEl.remove();
			activeRef.current = null;
		}
		resizeActive = false;
		setCssProps(document.body, { cursor: '', userSelect: '' });
	}, [autoScroller]);

	/**
	 * 在块手柄 mousedown 时调用（仅主键）。
	 * 返回 true 表示已接管该手势。
	 */
	const beginResize = useCallback((
		e: ReactPointerEvent,
		block: TimeBlock,
		seg: TimeBlockSegment,
		edge: 'top' | 'bottom',
		columnEl: HTMLElement,
		blockEl: HTMLElement,
	): boolean => {
		if (e.button !== 0) return false;
		e.preventDefault();
		e.stopPropagation();
		detach(); // 防御：上一次手势未正常收尾时先解绑
		resizeActive = true;

		const tipEl = createDiv(WeekViewClasses.elements.resizeTip);
		document.body.appendChild(tipEl);

		const active: ActiveResize = {
			block,
			seg,
			edge,
			columnEl,
			blockEl,
			newStartMin: seg.startMin,
			newEndMin: seg.endMin,
			changed: false,
			tipEl,
		};
		activeRef.current = active;
		lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY, altKey: e.altKey };

		// 时刻标签只查一次（原每次 pointermove 都 querySelector）
		const label = blockEl.querySelector(`.${WeekViewClasses.elements.timeBlockTime}`);

		const applyPreview = (clientX: number, clientY: number, altKey: boolean) => {
			if (activeRef.current !== active) return;
			const rect = active.columnEl.getBoundingClientRect();
			const minutes = snapMinutes(pxToMinutes(clientY - rect.top), altKey);

			if (active.edge === 'top') {
				// 上边缘：钳制 [0, 段终点 - 最小时长]
				active.newStartMin = Math.max(0, Math.min(minutes, active.seg.endMin - MIN_DURATION_MIN));
			} else {
				// 下边缘：钳制 [段起点 + 最小时长, 24:00]
				active.newEndMin = Math.min(24 * 60, Math.max(minutes, active.seg.startMin + MIN_DURATION_MIN));
			}

			if (active.newStartMin === active.seg.startMin && active.newEndMin === active.seg.endMin && !active.changed) return;
			active.changed = active.newStartMin !== active.seg.startMin || active.newEndMin !== active.seg.endMin;

			// 乐观 DOM 预览
			active.blockEl.style.top = `${minutesToPx(active.newStartMin)}px`;
			active.blockEl.style.height = `${minutesToPx(active.newEndMin - active.newStartMin)}px`;
			if (label) label.textContent = `${formatMinutes(active.newStartMin)} – ${formatMinutes(active.newEndMin)}`;
			active.tipEl.style.left = `${clientX + 12}px`;
			active.tipEl.style.top = `${clientY - 28}px`;
			active.tipEl.textContent = `${formatMinutes(active.newStartMin)} – ${formatMinutes(active.newEndMin)}`;
		};

		applyPreviewRef.current = applyPreview;
		const frame = rafThrottle(applyPreview);

		const move = (ev: PointerEvent) => {
			lastPointerRef.current = { clientX: ev.clientX, clientY: ev.clientY, altKey: ev.altKey };
			frame(ev.clientX, ev.clientY, ev.altKey);
			autoScroller.update(ev.clientY);
		};

		const end = () => {
			// 松手前停止自动滚动并落实最后一次挂起的位置（提交值与预览一致）
			autoScroller.stop();
			frame.flush();
			const finished = activeRef.current;
			detach();
			if (!finished || !finished.changed) return; // 未产生时间变化：样式未被改写，无需提交
			commitRef.current(finished.block, finished.seg, finished.edge, finished.newStartMin, finished.newEndMin, finished.blockEl);
		};

		const cancel = () => {
			detach();
		};

		handlersRef.current = { move, end, cancel, frame };
		setCssProps(document.body, { cursor: 'ns-resize', userSelect: 'none' });
		document.addEventListener('pointermove', move);
		document.addEventListener('pointerup', end);
		document.addEventListener('pointercancel', cancel);
		return true;
	}, [autoScroller, detach]);

	// 组件卸载时强制解绑（甘特控制器的 destroy 模式）
	useEffect(() => () => detach(), [detach]);

	return beginResize;
}
