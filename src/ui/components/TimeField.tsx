import { useEffect, useState, type JSX, type KeyboardEvent } from 'react';
import { WhenPickerClasses as C } from '../../utils/bem';
import { parseWhenText } from '../../utils/parseWhenText';
import { formatHm, hmToMin, minToHm, type TimeFormat } from '../../utils/timeOfDay';

export interface TimeFieldProps {
	/** "HH:mm"（24 小时制存储），空串 = 未设置 */
	value: string;
	onChange: (hm: string) => void;
	timeFormat: TimeFormat;
	placeholder?: string;
	ariaLabel: string;
	disabled?: boolean;
	/** ↑/↓ 在未设置时的起点 */
	fallbackMin?: number;
}

/**
 * 时刻输入框：显示随插件 12/24 小时制；输入宽松（14、1430、2p、14.30、下午2点），
 * 回车 / 失焦提交，无法识别时还原；↑/↓ ±15 分钟、Shift+↑/↓ ±1 小时。
 * 取代原生 <input type="time">（跟随系统区域、带 Chromium 时钟图标，与 Obsidian 风格不符）
 */
export function TimeField({ value, onChange, timeFormat, placeholder, ariaLabel, disabled, fallbackMin = 9 * 60 }: TimeFieldProps): JSX.Element {
	const [draft, setDraft] = useState<string | null>(null);
	useEffect(() => setDraft(null), [value]);

	const commit = () => {
		if (draft === null) return;
		const t = draft.trim();
		if (!t) {
			onChange('');
		} else {
			const parsed = parseWhenText(t.replace('.', ':'));
			if (parsed?.timeStart && !parsed.start) onChange(parsed.timeStart);
		}
		setDraft(null);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			commit();
			return;
		}
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			const step = (e.shiftKey ? 60 : 15) * (e.key === 'ArrowUp' ? 1 : -1);
			const cur = hmToMin(value) ?? fallbackMin - step;
			onChange(minToHm(Math.max(0, Math.min(24 * 60, cur + step))));
			setDraft(null);
		}
	};

	return (
		<input
			type="text"
			inputMode="numeric"
			className={C.elements.timeInput}
			aria-label={ariaLabel}
			placeholder={placeholder}
			disabled={disabled}
			value={draft ?? formatHm(value, timeFormat)}
			onChange={(e) => setDraft(e.target.value)}
			onFocus={(e) => e.currentTarget.select()}
			onBlur={commit}
			onKeyDown={onKeyDown}
		/>
	);
}
