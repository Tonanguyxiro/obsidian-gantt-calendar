import { useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import { WhenPickerClasses as C } from '../../utils/bem';
import { hmToMin, minToHm, snapMin, type TimeFormat } from '../../utils/timeOfDay';

export interface HourStripProps {
	start: string;
	end: string;
	/** 拖动结束后提交（拖动过程中只更新本地预览，不触发外部重渲染） */
	onChange: (start: string, end: string) => void;
	timeFormat: TimeFormat;
	disabled?: boolean;
}

const DAY = 24 * 60;
const MIN_LEN = 15;
const EDGE_PX = 6;
const TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

type Drag =
	| { kind: 'paint'; anchor: number }
	| { kind: 'move'; offset: number; len: number }
	| { kind: 'start' | 'end' };

/**
 * 0–24 小时条：在空白处拖动画出时间块（吸附 15 分钟），拖块身移动、拖两端调整。
 * 夜间 00–06 加浅底色，帮助一眼定位白天时段。
 */
export function HourStrip({ start, end, onChange, timeFormat, disabled }: HourStripProps): JSX.Element {
	const ref = useRef<HTMLDivElement>(null);
	const dragRef = useRef<Drag | null>(null);
	const [preview, setPreviewState] = useState<[number, number] | null>(null);
	// 指针抬起时以 ref 为准：移动与抬起落在同一帧时 state 还没更新
	const previewRef = useRef<[number, number] | null>(null);
	const setPreview = (v: [number, number] | null) => {
		previewRef.current = v;
		setPreviewState(v);
	};

	const s0 = hmToMin(start);
	const e0 = hmToMin(end) ?? (s0 !== null ? Math.min(s0 + MIN_LEN, DAY) : null);
	const [s, e] = preview ?? (s0 !== null && e0 !== null ? [s0, e0] : [null, null]);

	const minAt = (clientX: number) => {
		const r = ref.current!.getBoundingClientRect();
		return snapMin(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * DAY);
	};

	const onPointerDown = (ev: ReactPointerEvent<HTMLDivElement>) => {
		if (disabled || ev.button !== 0) return;
		ev.preventDefault();
		const m = minAt(ev.clientX);
		const r = ref.current!.getBoundingClientRect();
		const pxPerMin = r.width / DAY;
		if (s !== null && e !== null) {
			const sx = r.left + s * pxPerMin;
			const ex = r.left + e * pxPerMin;
			if (Math.abs(ev.clientX - sx) <= EDGE_PX) dragRef.current = { kind: 'start' };
			else if (Math.abs(ev.clientX - ex) <= EDGE_PX) dragRef.current = { kind: 'end' };
			else if (ev.clientX > sx && ev.clientX < ex) dragRef.current = { kind: 'move', offset: m - s, len: e - s };
		}
		if (!dragRef.current) {
			dragRef.current = { kind: 'paint', anchor: m };
			setPreview([m, Math.min(m + MIN_LEN, DAY)]);
		}
		try {
			ev.currentTarget.setPointerCapture(ev.pointerId);
		} catch {
			// 合成事件 / 已失效的指针：不捕获也能工作
		}
	};

	const onPointerMove = (ev: ReactPointerEvent<HTMLDivElement>) => {
		const d = dragRef.current;
		if (!d) return;
		const m = minAt(ev.clientX);
		const cur = previewRef.current;
		const cs = cur?.[0] ?? s ?? 0;
		const ce = cur?.[1] ?? e ?? MIN_LEN;
		if (d.kind === 'paint') {
			const a = Math.min(d.anchor, m);
			const b = Math.max(d.anchor, m);
			setPreview([a, Math.max(b, a + MIN_LEN)]);
		} else if (d.kind === 'move') {
			const ns = Math.max(0, Math.min(DAY - d.len, m - d.offset));
			setPreview([ns, ns + d.len]);
		} else if (d.kind === 'start') {
			setPreview([Math.min(m, ce - MIN_LEN), ce]);
		} else {
			setPreview([cs, Math.max(m, cs + MIN_LEN)]);
		}
	};

	const onPointerUp = () => {
		const cur = previewRef.current;
		if (dragRef.current && cur) onChange(minToHm(cur[0]), minToHm(cur[1]));
		dragRef.current = null;
		setPreview(null);
	};

	const label = (h: number) => {
		if (timeFormat === '24h') return String(h);
		if (h === 0 || h === 24) return '12a';
		if (h === 12) return '12p';
		return String(h % 12);
	};

	return (
		<div
			ref={ref}
			className={`${C.elements.strip}${disabled ? ` ${C.modifiers.stripDisabled}` : ''}`}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			role="slider"
			aria-valuemin={0}
			aria-valuemax={DAY}
			aria-valuenow={s ?? undefined}
		>
			<div className={C.elements.stripNight} />
			{TICKS.slice(0, -1).map((h) => (
				<span key={h} className={C.elements.stripTick} style={{ left: `${(h / 24) * 100}%` }}>
					{label(h)}
				</span>
			))}
			{s !== null && e !== null ? (
				<div
					className={C.elements.stripBlock}
					style={{ left: `${(s / DAY) * 100}%`, width: `${((e - s) / DAY) * 100}%` }}
				/>
			) : null}
		</div>
	);
}
