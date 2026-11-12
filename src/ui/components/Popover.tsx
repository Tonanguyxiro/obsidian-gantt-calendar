import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DateTimePickerClasses, PopoverClasses } from '../../utils/bem';

export interface PopoverProps {
	/** 触发器：拿到开关函数与当前状态 */
	trigger: (props: { toggle: () => void; open: boolean; ref: (el: HTMLElement | null) => void }) => ReactNode;
	/** 弹层内容；close 用于内容里主动关闭 */
	children: (close: () => void) => ReactNode;
	/** 弹层宽度（px） */
	width?: number;
}

const GAP = 6;
const MARGIN = 8;

/**
 * 锚定在触发器下方的弹层（可在弹窗里使用）：
 * - 下方放不下时翻到上方，左右夹在视口内
 * - 外部点击关闭；弹层里打开的日期选择器（自身也是 portal）不算外部
 * - Esc 只关弹层，不连带关闭外层弹窗；日期选择器开着时先交给它
 */
export function Popover({ trigger, children, width = 360 }: PopoverProps): JSX.Element {
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	// 弹层只长不缩：内容变矮（如切换页签）时保留高度，顶部控件位置不变、弹层不脱离触发器
	const [minH, setMinH] = useState(0);
	const anchorRef = useRef<HTMLElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);

	const close = useCallback(() => {
		setOpen(false);
		setPos(null);
		setMinH(0);
	}, []);
	const toggle = useCallback(() => setOpen((o) => !o), []);
	const setAnchor = useCallback((el: HTMLElement | null) => {
		anchorRef.current = el;
	}, []);

	// 先隐藏渲染测量高度，再决定放在下方还是上方
	useLayoutEffect(() => {
		if (!open || !anchorRef.current || !panelRef.current) return;
		const a = anchorRef.current.getBoundingClientRect();
		const h = panelRef.current.offsetHeight;
		const w = panelRef.current.offsetWidth;
		const below = a.bottom + GAP;
		const top = below + h + MARGIN <= window.innerHeight ? below : Math.max(MARGIN, a.top - GAP - h);
		const left = Math.min(Math.max(MARGIN, a.left), window.innerWidth - w - MARGIN);
		setPos({ top, left });
	}, [open, minH]);

	// 内容变高时撑大并重新定位；变矮时保持原高度
	useEffect(() => {
		const el = panelRef.current;
		if (!open || !el || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => {
			const h = el.offsetHeight;
			setMinH((prev) => (h > prev ? h : prev));
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const pickerOpen = () => !!document.querySelector(`.${DateTimePickerClasses.elements.popover}`);
		const onMouseDown = (e: MouseEvent) => {
			const t = e.target as Element;
			if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
			if (t.closest?.(`.${DateTimePickerClasses.elements.popover}`)) return;
			close();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== 'Escape' || pickerOpen()) return;
			e.stopPropagation();
			close();
		};
		const onResize = () => close();
		document.addEventListener('mousedown', onMouseDown);
		document.addEventListener('keydown', onKeyDown, true);
		window.addEventListener('resize', onResize);
		return () => {
			document.removeEventListener('mousedown', onMouseDown);
			document.removeEventListener('keydown', onKeyDown, true);
			window.removeEventListener('resize', onResize);
		};
	}, [open, close]);

	return (
		<>
			{trigger({ toggle, open, ref: setAnchor })}
			{open
				? createPortal(
					<div
						ref={panelRef}
						role="dialog"
						className={PopoverClasses.block}
						style={{
							width: `${width}px`,
							minHeight: minH ? `${minH}px` : undefined,
							maxWidth: `calc(100vw - ${MARGIN * 2}px)`,
							top: pos?.top ?? -9999,
							left: pos?.left ?? -9999,
							visibility: pos ? 'visible' : 'hidden',
						}}
					>
						{children(close)}
					</div>,
					document.body,
				)
				: null}
		</>
	);
}
