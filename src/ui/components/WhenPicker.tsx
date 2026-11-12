import { useMemo, useState, type JSX, type KeyboardEvent } from 'react';
import { WhenPickerClasses as C } from '../../utils/bem';
import { i18n } from '../../i18n/i18n';
import { parseWhenText, type WhenParseResult } from '../../utils/parseWhenText';
import { formatDuration, formatHm, hmToMin, minToHm, type TimeFormat } from '../../utils/timeOfDay';
import { MonthRangeCalendar } from './MonthRangeCalendar';
import { TimeField } from './TimeField';
import { HourStrip } from './HourStrip';

/**
 * 任务「时间」值，严格对应 Tasks 插件的字段：
 * - 时间段任务：🛫 start + 📅 due（可只有其一）
 * - 当日任务：⏳ scheduled + 行首时间前缀（timeStart / timeEnd，"HH:mm"）
 */
export interface WhenValue {
	kind: 'period' | 'day';
	start: Date | null;
	due: Date | null;
	scheduled: Date | null;
	timeStart: string;
	timeEnd: string;
}

export interface WhenPickerProps {
	value: WhenValue;
	onChange: (v: WhenValue) => void;
	timeFormat: TimeFormat;
}

type Armed = 'start' | 'due';

const day0 = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a: Date | null, b: Date | null) => !!a && !!b && day0(a).getTime() === day0(b).getTime();
const daysBetween = (a: Date, b: Date) => Math.round((day0(b).getTime() - day0(a).getTime()) / 86400000);

/** 默认开始时刻：今天 = 下一个整点（最晚 23:00），其他日子 = 09:00 */
function defaultStartMin(day: Date | null): number {
	const now = new Date();
	if (day && sameDay(day, now)) return Math.min(23 * 60, (now.getHours() + 1) * 60);
	return 9 * 60;
}

/**
 * 「时间」面板：快速输入 + 常用日期 + 起止格 + 月历 + 时刻 + 小时条。
 * 每一段都是固定高度、始终渲染：切换类型 / 选择日期不会让任何控件移动。
 * - 时间段：先选开始，自动转到截止；在开始之前点击会交换；只设截止也可以（只写 📅）
 * - 当日：点日期即设 ⏳；设置时刻（输入、拖动小时条、时长按钮）自动切换为当日
 * - 选出跨多天的区间自动切换为时间段
 */
export function WhenPicker({ value, onChange, timeFormat }: WhenPickerProps): JSX.Element {
	const [armed, setArmed] = useState<Armed>(value.start || !value.due ? (value.start && !value.due ? 'due' : 'start') : 'due');
	const [text, setText] = useState('');
	const [shake, setShake] = useState(false);
	const isPeriod = value.kind === 'period';

	const preview: WhenParseResult | null = useMemo(() => (text.trim() ? parseWhenText(text) : null), [text]);

	const set = (patch: Partial<WhenValue>) => onChange({ ...value, ...patch });

	// ---------- 快速输入 ----------
	const applyParsed = (r: WhenParseResult) => {
		const next: WhenValue = { ...value };
		if (r.start && r.end && !sameDay(r.start, r.end)) {
			next.kind = 'period';
			next.start = r.start;
			next.due = r.end;
		} else if (r.start) {
			if (r.timeStart || !isPeriod) {
				next.kind = 'day';
				next.scheduled = r.start;
			} else if (armed === 'start') {
				next.start = r.start;
				if (next.due && next.due < r.start) next.due = r.start;
			} else {
				next.due = r.start;
			}
		}
		if (r.timeStart) {
			next.kind = 'day';
			next.scheduled = next.scheduled ?? r.start ?? day0(new Date());
			next.timeStart = r.timeStart;
			next.timeEnd = r.timeEnd ?? '';
		}
		onChange(next);
	};

	const onTextKey = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key !== 'Enter') return;
		e.preventDefault();
		if (preview) {
			applyParsed(preview);
			setText('');
		} else if (text.trim()) {
			setShake(true);
			window.setTimeout(() => setShake(false), 400);
		}
	};

	// ---------- 常用日期 ----------
	const today = day0(new Date());
	const weekEnd = addDays(today, (7 - today.getDay()) % 7);
	const chips: Array<{ key: string; label: string; apply: () => void }> = [
		{ key: 'today', label: i18n.t('modals.when.today'), apply: () => pickDay(today) },
		{ key: 'tomorrow', label: i18n.t('modals.when.tomorrow'), apply: () => pickDay(addDays(today, 1)) },
		{ key: 'week', label: i18n.t('modals.when.thisWeek'), apply: () => onChange({ ...value, kind: 'period', start: today, due: weekEnd }) },
	];

	// ---------- 日历点击 ----------
	function pickDay(d: Date) {
		if (!isPeriod) {
			set({ scheduled: d });
			return;
		}
		if (armed === 'start') {
			const due = value.due && value.due < d ? null : value.due;
			onChange({ ...value, start: d, due });
			setArmed('due');
		} else if (value.start && d < value.start) {
			// 截止早于开始：交换，保持截止格选中
			onChange({ ...value, start: d, due: value.start });
		} else {
			onChange({ ...value, due: d });
		}
	}

	// ---------- 时刻 ----------
	const toDay = (patch: Partial<WhenValue>) => onChange({
		...value,
		...patch,
		kind: 'day',
		scheduled: value.scheduled ?? value.start ?? value.due ?? today,
	});
	const setTimeStart = (hm: string) => {
		if (!hm) {
			toDay({ timeStart: '', timeEnd: '' });
			return;
		}
		// 结束不晚于开始时顺延到开始 + 原时长（默认 1 小时）
		const s = hmToMin(hm)!;
		const oldS = hmToMin(value.timeStart);
		const oldE = hmToMin(value.timeEnd);
		const len = oldS !== null && oldE !== null ? oldE - oldS : null;
		const e = hmToMin(value.timeEnd);
		const timeEnd = e !== null && e <= s ? minToHm(Math.min(24 * 60, s + (len && len > 0 ? len : 60))) : value.timeEnd;
		toDay({ timeStart: hm, timeEnd });
	};
	const setTimeEnd = (hm: string) => {
		const s = hmToMin(value.timeStart);
		const e = hmToMin(hm);
		if (e !== null && s !== null && e <= s) {
			toDay({ timeEnd: minToHm(Math.min(24 * 60, s + 15)) });
			return;
		}
		toDay({ timeStart: value.timeStart || (e !== null ? minToHm(Math.max(0, e - 60)) : ''), timeEnd: hm });
	};
	const setDuration = (min: number | null) => {
		if (min === null) {
			toDay({ timeStart: '', timeEnd: '' });
			return;
		}
		const s = hmToMin(value.timeStart) ?? defaultStartMin(value.scheduled ?? value.start ?? today);
		toDay({ timeStart: minToHm(s), timeEnd: minToHm(Math.min(24 * 60, s + min)) });
	};
	const curLen = (() => {
		const s = hmToMin(value.timeStart);
		const e = hmToMin(value.timeEnd);
		return s !== null && e !== null ? e - s : null;
	})();

	// ---------- 显示 ----------
	const fmtCell = (d: Date | null) => {
		if (!d) return '—';
		const sameYear = d.getFullYear() === today.getFullYear();
		return window.moment(d).format(i18n.t(sameYear ? 'modals.when.cellFormat' : 'modals.when.cellFormatYear'));
	};

	const hint = (() => {
		if (text.trim()) {
			if (!preview) return { text: i18n.t('modals.when.notUnderstood'), bad: true };
			return { text: `↵ ${describe(preview, timeFormat)}`, bad: false };
		}
		if (!isPeriod) return { text: i18n.t('modals.when.hintDay'), bad: false };
		const span = value.start && value.due ? daysBetween(value.start, value.due) + 1 : null;
		const base = armed === 'start' ? i18n.t('modals.when.hintStart') : i18n.t('modals.when.hintDue');
		return { text: span ? `${base} · ${i18n.t('modals.when.days', { count: span })}` : base, bad: false };
	})();

	const calStart = isPeriod ? value.start ?? value.due : value.scheduled;
	const calEnd = isPeriod ? value.due : null;

	return (
		<div className={C.block}>
			{/* 1. 快速输入 */}
			<input
				type="text"
				className={`${C.elements.quick}${shake ? ` ${C.modifiers.quickShake}` : ''}`}
				placeholder={i18n.t('modals.when.quickPlaceholder')}
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={onTextKey}
				aria-label={i18n.t('modals.when.quickPlaceholder')}
			/>

			{/* 2. 类型 + 常用日期 */}
			<div className={C.elements.row}>
				<div className={C.elements.kind} role="tablist">
					{(['period', 'day'] as const).map((k) => (
						<button
							key={k}
							type="button"
							role="tab"
							aria-selected={value.kind === k}
							data-kind={k}
							className={`${C.elements.kindBtn}${value.kind === k ? ` ${C.modifiers.kindActive}` : ''}`}
							onClick={() => onChange({
								...value,
								kind: k,
								// 切到当日且还没有日期：沿用开始 / 截止日
								scheduled: k === 'day' ? value.scheduled ?? value.start ?? value.due : value.scheduled,
							})}
						>
							{i18n.t(k === 'period' ? 'modals.task.kindPeriod' : 'modals.task.kindDay')}
						</button>
					))}
				</div>
				<div className={C.elements.chips}>
					{chips.map((c) => (
						<button key={c.key} type="button" data-chip={c.key} className={C.elements.chip} onClick={c.apply}>
							{c.label}
						</button>
					))}
				</div>
			</div>

			{/* 3. 日期格：时间段 = 开始 | 截止；当日 = 日期（同一位置、同一高度） */}
			<div className={C.elements.cells}>
				{isPeriod ? (
					(['start', 'due'] as const).map((k) => {
						const v = k === 'start' ? value.start : value.due;
						return (
							<div
								key={k}
								role="button"
								tabIndex={0}
								data-cell={k}
								className={`${C.elements.cell}${armed === k ? ` ${C.modifiers.cellArmed}` : ''}`}
								onClick={() => setArmed(k)}
								onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setArmed(k); }}
							>
								<span className={C.elements.cellLabel}>
									{k === 'start' ? i18n.t('modals.createTask.dateFields.start') : i18n.t('modals.createTask.dateFields.due')}
								</span>
								<span className={C.elements.cellValue}>{fmtCell(v)}</span>
								<button
									type="button"
									className={`clickable-icon ${C.elements.cellClear}${v ? '' : ` ${C.modifiers.cellClearHidden}`}`}
									aria-label={i18n.t('modals.task.clearTime')}
									tabIndex={v ? 0 : -1}
									onClick={(e) => {
										e.stopPropagation();
										set(k === 'start' ? { start: null } : { due: null });
										setArmed(k);
									}}
								>
									×
								</button>
							</div>
						);
					})
				) : (
					<div data-cell="scheduled" className={`${C.elements.cell} ${C.modifiers.cellWide} ${C.modifiers.cellArmed}`}>
						<span className={C.elements.cellLabel}>{i18n.t('modals.createTask.dateFields.scheduled')}</span>
						<span className={C.elements.cellValue}>{fmtCell(value.scheduled)}</span>
						<button
							type="button"
							className={`clickable-icon ${C.elements.cellClear}${value.scheduled ? '' : ` ${C.modifiers.cellClearHidden}`}`}
							aria-label={i18n.t('modals.task.clearTime')}
							onClick={() => set({ scheduled: null })}
						>
							×
						</button>
					</div>
				)}
			</div>

			{/* 4. 月历 */}
			<MonthRangeCalendar
				start={calStart}
				end={calEnd}
				onChange={() => undefined}
				onPick={pickDay}
				previewEnd={isPeriod && armed === 'due' && !!value.start}
				hideHint
				focusDate={isPeriod ? (armed === 'start' ? value.start : value.due) ?? calStart : value.scheduled}
			/>

			{/* 5. 提示 / 快速输入预览（固定一行） */}
			<div className={`${C.elements.hint}${hint.bad ? ` ${C.modifiers.hintBad}` : ''}`}>{hint.text}</div>

			{/* 6. 时刻：始终渲染；时间段任务下变淡（时刻只属于当日任务），设置时刻即切到当日 */}
			<div className={`${C.elements.time}${isPeriod ? ` ${C.modifiers.timeMuted}` : ''}`}>
				<div className={C.elements.timeRow}>
					<TimeField
						value={value.timeStart}
						onChange={setTimeStart}
						timeFormat={timeFormat}
						placeholder={i18n.t('modals.task.allDay')}
						ariaLabel={i18n.t('modals.task.startTime')}
						fallbackMin={defaultStartMin(value.scheduled)}
					/>
					<span className={C.elements.timeDash}>–</span>
					<TimeField
						value={value.timeEnd}
						onChange={setTimeEnd}
						timeFormat={timeFormat}
						placeholder="—"
						ariaLabel={i18n.t('modals.task.endTime')}
						fallbackMin={(hmToMin(value.timeStart) ?? defaultStartMin(value.scheduled)) + 60}
					/>
					<div className={C.elements.durations}>
						{[30, 60, 120].map((m) => (
							<button
								key={m}
								type="button"
								data-duration={m}
								className={`${C.elements.chip}${!isPeriod && curLen === m ? ` ${C.modifiers.chipActive}` : ''}`}
								onClick={() => setDuration(m)}
							>
								{m < 60 ? `${m}m` : `${m / 60}h`}
							</button>
						))}
						<button
							type="button"
							data-duration="all"
							className={`${C.elements.chip}${!isPeriod && !value.timeStart ? ` ${C.modifiers.chipActive}` : ''}`}
							onClick={() => setDuration(null)}
						>
							{i18n.t('modals.task.allDay')}
						</button>
					</div>
				</div>
				<HourStrip
					start={isPeriod ? '' : value.timeStart}
					end={isPeriod ? '' : value.timeEnd}
					timeFormat={timeFormat}
					onChange={(s, e) => toDay({ timeStart: s, timeEnd: e })}
				/>
				<div className={C.elements.caption}>
					{isPeriod ? i18n.t('modals.when.timeForDay') : i18n.t('modals.when.timeHint')}
				</div>
			</div>
		</div>
	);
}

/** 快速输入预览文本 */
function describe(r: WhenParseResult, fmt: TimeFormat): string {
	const f = (d: Date) => window.moment(d).format(i18n.t('modals.when.previewFormat'));
	const parts: string[] = [];
	if (r.start && r.end && !sameDay(r.start, r.end)) parts.push(`${f(r.start)} → ${f(r.end)}`);
	else if (r.start) parts.push(f(r.start));
	if (r.timeStart) {
		let t = formatHm(r.timeStart, fmt);
		if (r.timeEnd) {
			t += `–${formatHm(r.timeEnd, fmt)}`;
			const len = (hmToMin(r.timeEnd) ?? 0) - (hmToMin(r.timeStart) ?? 0);
			if (len > 0) t += ` · ${formatDuration(len)}`;
		}
		parts.push(t);
	}
	return parts.join(' · ');
}
