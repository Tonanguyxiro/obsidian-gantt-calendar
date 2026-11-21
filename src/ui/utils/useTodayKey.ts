import { useEffect, useState } from 'react';
import { getTodayInTimezone } from '../../dateUtils/timezone';

/** 配置时区下"今天"的日期键（YYYY-MM-DD） */
export function getTodayKey(): string {
	const d = getTodayInTimezone();
	return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * 订阅"今天"的变化：跨过午夜（或休眠恢复、窗口重新获得焦点）后返回新键。
 *
 * 视图里按 `isToday` 预计算的日期数据（周/月/年网格、日画布当前时间线）
 * 需把返回值放进 useMemo 依赖，否则长时间挂着的视图会一直高亮昨天。
 */
export function useTodayKey(): string {
	const [key, setKey] = useState(getTodayKey);
	useEffect(() => {
		const sync = (): void => {
			const fresh = getTodayKey();
			setKey((prev) => (prev === fresh ? prev : fresh));
		};
		const onWake = (): void => {
			if (!document.hidden) sync();
		};
		const timer = window.setInterval(sync, 60_000);
		document.addEventListener('visibilitychange', onWake);
		window.addEventListener('focus', onWake);
		return () => {
			window.clearInterval(timer);
			document.removeEventListener('visibilitychange', onWake);
			window.removeEventListener('focus', onWake);
		};
	}, []);
	return key;
}
