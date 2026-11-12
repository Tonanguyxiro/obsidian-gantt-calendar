import { useEffect, useMemo, useState, type JSX } from 'react';
import { MonthRangeCalendarClasses as C } from '../../utils/bem';
import { i18n } from '../../i18n/i18n';
import { buildMonthGrid } from './DateTimePicker';
import { Icon } from './Icon';

export interface MonthRangeCalendarProps {
	start: Date | null;
	end: Date | null;
	/** 选区变化：第一次点击设开始（清空结束），第二次点击设结束（早于开始则改为新的开始） */
	onChange: (start: Date | null, end: Date | null) => void;
	/** 由外部决定点击含义（如「时间」面板按当前选中的格子写入）；提供时不走内置的两次点击逻辑 */
	onPick?: (day: Date) => void;
	/** 悬停预览终点（正在选结束日期时） */
	previewEnd?: boolean;
	/** 隐藏底部提示行（外部自带提示时） */
	hideHint?: boolean;
	/** 变化时翻到该日期所在月份（如快速输入跳到别的月） */
	focusDate?: Date | null;
}

const dayMs = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * 时间段任务的快速选区：内联月历，点两下选出开始 ~ 截止。
 * 默认显示开始日所在月（没有则本月），可前后翻月；悬停预览区间。
 */
export function MonthRangeCalendar({ start, end, onChange, onPick, previewEnd, hideHint, focusDate }: MonthRangeCalendarProps): JSX.Element {
	const anchor = start ?? end ?? new Date();
	const [view, setView] = useState({ year: anchor.getFullYear(), month: anchor.getMonth() + 1 });
	const [hover, setHover] = useState<Date | null>(null);
	const focusKey = focusDate ? focusDate.getFullYear() * 12 + focusDate.getMonth() : null;
	useEffect(() => {
		if (focusKey === null) return;
		setView({ year: Math.floor(focusKey / 12), month: (focusKey % 12) + 1 });
	}, [focusKey]);
	const grid = useMemo(() => buildMonthGrid(view.year, view.month), [view]);
	const weekdays = i18n.t('views.yearView.weekdaysShortMon') as unknown as string[];
	const today = dayMs(new Date());

	// 只选了开始时，悬停处作为临时终点预览
	const lo = start ? dayMs(start) : null;
	const wantPreview = previewEnd ?? (!!start && !end);
	const hiRaw = wantPreview && start && hover ? dayMs(hover) : (end ? dayMs(end) : null);
	const [from, to] = lo !== null && hiRaw !== null ? [Math.min(lo, hiRaw), Math.max(lo, hiRaw)] : [lo, lo];

	const shift = (delta: number) => setView((v) => {
		const m = v.month - 1 + delta;
		return { year: v.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 + 1 };
	});

	const pick = (d: Date) => {
		const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
		if (onPick) {
			onPick(day);
			return;
		}
		if (!start || end) {
			onChange(day, null);
		} else if (dayMs(day) < dayMs(start)) {
			onChange(day, null);
		} else {
			onChange(start, day);
		}
	};

	return (
		<div className={C.block} onMouseLeave={() => setHover(null)}>
			<div className={C.elements.header}>
				<button type="button" className={`clickable-icon ${C.elements.nav}`} aria-label={i18n.t('toolbar.nav.previous')} onClick={() => shift(-1)}>
					<Icon icon="chevron-left" />
				</button>
				<span className={C.elements.title}>{window.moment(new Date(view.year, view.month - 1, 1)).format(i18n.t('modals.task.rangeMonthFormat'))}</span>
				<button type="button" className={`clickable-icon ${C.elements.nav}`} aria-label={i18n.t('toolbar.nav.next')} onClick={() => shift(1)}>
					<Icon icon="chevron-right" />
				</button>
			</div>
			<div className={C.elements.grid}>
				{weekdays.map((w, i) => <span key={`w${i}`} className={C.elements.weekday}>{w}</span>)}
				{grid.map((d) => {
					const t = dayMs(d);
					const inRange = from !== null && to !== null && t >= from && t <= to;
					const cls = [
						C.elements.day,
						d.getMonth() + 1 !== view.month ? C.modifiers.outside : '',
						inRange ? C.modifiers.inRange : '',
						t === from ? C.modifiers.rangeStart : '',
						t === to ? C.modifiers.rangeEnd : '',
						t === today ? C.modifiers.today : '',
					].filter(Boolean).join(' ');
					return (
						<button
							key={t}
							type="button"
							className={cls}
							data-date={window.moment(d).format('YYYY-MM-DD')}
							onMouseEnter={() => setHover(d)}
							onClick={() => pick(d)}
						>
							<span>{d.getDate()}</span>
						</button>
					);
				})}
			</div>
			{hideHint ? null : <div className={C.elements.hint}>
				{!start || end ? i18n.t('modals.task.rangeHintStart') : i18n.t('modals.task.rangeHintEnd')}
			</div>}
		</div>
	);
}
