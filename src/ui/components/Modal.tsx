import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { ModalClasses, setCssProps } from '../../utils/bem';
import { Icon } from './Icon';
import { MOTION, modalVariants, overlayVariants, easeOutTransition } from '../motion';

/**
 * 兜底：motion 的 rAF 在后台标签页 / 无头环境可能不触发，进场动画停在 initial
 * （opacity: 0），弹窗"打开了但看不见"。这里把仍为 0 的遮罩与面板强制写成可见；
 * 只在 open 后调用，关闭动画照常由 AnimatePresence 驱动。
 */
export function ensureModalVisible(overlay: HTMLElement | null, panel: HTMLElement | null): void {
	for (const el of [overlay, panel]) {
		if (!el) continue;
		if (window.getComputedStyle(el).opacity === '0') setCssProps(el, { opacity: '1' });
	}
}

export interface ModalProps {
	open: boolean;
	onClose: () => void;
	title?: ReactNode;
	children: ReactNode;
	className?: string;
	/** 面板宽度（px），默认自适应 */
	width?: number;
	/** 点击遮罩关闭，默认 true */
	closeOnClickOutside?: boolean;
	/** Esc 关闭，默认 true */
	closeOnEsc?: boolean;
	/** 退出动画完成后触发（用于从宿主安全移除） */
	onExited?: () => void;
}

/**
 * 声明式模态框：portal 渲染到 body
 * 受控组件：open 由父组件状态控制，onClose 负责关闭
 */
export function Modal({
	open,
	onClose,
	title,
	children,
	className,
	width,
	closeOnClickOutside = true,
	closeOnEsc = true,
	onExited,
}: ModalProps): JSX.Element | null {
	const panelRef = useRef<HTMLDivElement | null>(null);
	const overlayRef = useRef<HTMLDivElement | null>(null);

	// 退出收尾只做一次：正常由退出动画完成回调触发；动画被节流 / 打断时（窗口在后台、
	// 连续打开关闭）回调可能不来，透明的遮罩会留在页面上挡住所有点击——超时兜底移除
	const exitedRef = useRef(false);
	const onExitedRef = useRef(onExited);
	onExitedRef.current = onExited;
	const finishExit = () => {
		if (exitedRef.current) return;
		exitedRef.current = true;
		onExitedRef.current?.();
	};
	useEffect(() => {
		if (open) {
			exitedRef.current = false;
			return;
		}
		// 关闭瞬间就让遮罩不再接收点击，动画照常播放
		overlayRef.current?.classList.add(ModalClasses.overlayClosing);
		const timer = window.setTimeout(finishExit, MOTION.dur.normal * 1000 + 400);
		return () => window.clearTimeout(timer);
	}, [open]);

	// 进场兜底：rAF 被打断时 motion 可能永远停在 opacity:0（弹窗不可见但遮罩还在）。
	// 300ms 后若计算样式仍为 0，直接写 inline opacity 让内容可见。
	useEffect(() => {
		if (!open) return;
		const timer = window.setTimeout(() => {
			ensureModalVisible(overlayRef.current, panelRef.current);
		}, 300);
		return () => window.clearTimeout(timer);
	}, [open]);

	// 卸载兜底：无论因何种路径消失（退出动画被打断 / 被父级直接 filter 掉），
	// 都保证遮罩不再拦截点击；finishExit 本身幂等，重复调用安全。
	useEffect(() => () => {
		overlayRef.current?.classList.add(ModalClasses.overlayClosing);
	}, []);

	useEffect(() => {
		if (!open) return;
		// 焦点管理：打开时记录来源并聚焦面板（键盘用户可直接 Tab 操作），
		// 关闭后把焦点归还触发元素
		const previouslyFocused = document.activeElement as HTMLElement | null;
		panelRef.current?.focus();
		const handleKeydown = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && closeOnEsc) onClose();
		};
		document.addEventListener('keydown', handleKeydown);
		return () => {
			document.removeEventListener('keydown', handleKeydown);
			// 触发元素可能已被卸载（右键菜单项打开弹窗时菜单先 close），
			// 归还焦点到已脱离 DOM 的节点无效且会让焦点落到 body
			if (previouslyFocused?.isConnected && document.contains(previouslyFocused)) {
				previouslyFocused.focus?.();
			}
		};
	}, [open, closeOnEsc, onClose]);

	useEffect(() => {
		if (!open) return;
		// 软键盘补偿（移动端）：键盘弹出时 visualViewport 变矮而 layout viewport 不变，
		// 固定定位的面板仍按全屏居中 → 表单底部被键盘遮挡。把可视视口高度写入
		// overlay 的 CSS 变量，react-base.css 据此切换顶部对齐并钳制面板高度；
		// 键盘收起自动还原。阈值滤掉地址栏/工具栏伸缩等非键盘的高度变化。
		const overlay = overlayRef.current;
		const vv = window.visualViewport;
		if (!overlay || !vv) return;
		const KEYBOARD_THRESHOLD_PX = 120;
		const update = () => {
			const keyboard = window.innerHeight - vv.height - vv.offsetTop;
			if (keyboard > KEYBOARD_THRESHOLD_PX) {
				overlay.classList.add('gc-kb-open');
				overlay.style.setProperty('--gc-kb-vvh', `${Math.max(240, Math.round(vv.height - 16))}px`);
			} else {
				overlay.classList.remove('gc-kb-open');
				overlay.style.removeProperty('--gc-kb-vvh');
			}
		};
		update();
		vv.addEventListener('resize', update);
		vv.addEventListener('scroll', update);
		return () => {
			vv.removeEventListener('resize', update);
			vv.removeEventListener('scroll', update);
			overlay.classList.remove('gc-kb-open');
			overlay.style.removeProperty('--gc-kb-vvh');
		};
	}, [open]);

	const classes = [ModalClasses.overlay, className].filter(Boolean).join(' ');

	return createPortal(
		<AnimatePresence onExitComplete={finishExit}>
			{open ? (
				<motion.div
					ref={overlayRef}
					className={classes}
					variants={overlayVariants}
					initial="initial"
					animate="animate"
					exit="exit"
					transition={easeOutTransition(MOTION.dur.normal)}
					onMouseDown={(e) => {
						if (closeOnClickOutside && e.target === e.currentTarget) onClose();
					}}
				>
					<motion.div
						ref={panelRef}
						tabIndex={-1}
						className={ModalClasses.panel}
						style={width ? { width: `${width}px`, maxWidth: '90vw' } : undefined}
						variants={modalVariants}
						transition={easeOutTransition(MOTION.dur.normal)}
					>
						{title !== undefined ? (
							<div className={ModalClasses.header}>
								<h2 className={ModalClasses.title}>{title}</h2>
								<button className={ModalClasses.closeBtn} aria-label="Close" onClick={onClose}>
									<Icon icon="x" />
								</button>
							</div>
						) : null}
						<div className={ModalClasses.content}>{children}</div>
					</motion.div>
				</motion.div>
			) : null}
		</AnimatePresence>,
		document.body
	);
}