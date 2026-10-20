/**
 * ICS 日历订阅服务（参考 Day Planner：只读、仅内存）
 *
 * 拉取订阅源 → 解析/展开 → 推入 calendarStore.icsEvents，由日/周/月视图渲染为只读事件。
 * 不写任何 markdown 文件。某次拉取失败时沿用该订阅上一次成功拉取的内容。
 */

import { Notice, requestUrl } from 'obsidian';
import type GanttCalendarPlugin from '../../../main';
import type { IcsConfiguration, IcsSubscription } from '../../settings/types';
import { useCalendarStore } from '../../ui/store/calendarStore';
import { parseIcs } from './icsParser';
import type { IcsCalendarEvent } from './icsTask';
import { Logger } from '../../utils/logger';
import { i18n } from '../../i18n/i18n';

export const ICS_DEFAULT_COLORS = ['#4f8cff', '#f5a623', '#3fb950', '#bd5fe0', '#e5484d', '#17b8a6'];

const DEFAULT_ICS_CONFIG: IcsConfiguration = { subscriptions: [], syncInterval: 0 };
const DAY_MS = 24 * 60 * 60 * 1000;
/** 导入窗口：过去 30 天 ~ 未来 365 天 */
const PAST_DAYS = 30;
const FUTURE_DAYS = 365;

export function getIcsConfig(plugin: GanttCalendarPlugin): IcsConfiguration {
	const config = { ...DEFAULT_ICS_CONFIG, ...(plugin.settings.syncConfiguration?.ics ?? {}) };
	// 旧数据补全颜色
	config.subscriptions = config.subscriptions.map((s, i) => (
		s.color ? s : { ...s, color: ICS_DEFAULT_COLORS[i % ICS_DEFAULT_COLORS.length] }
	));
	return config;
}

/** webcal:// 是 https 的别名 */
export function normalizeIcsUrl(url: string): string {
	const trimmed = url.trim();
	return trimmed.toLowerCase().startsWith('webcal://') ? 'https://' + trimmed.slice('webcal://'.length) : trimmed;
}

export class IcsService {
	/** url → 最近一次成功拉取的文本（拉取失败时回退） */
	private readonly lastGood = new Map<string, string>();
	private timer?: number;
	private interval = 0;
	/** 影响拉取结果的配置签名（启用的订阅地址）；变化才重新拉取 */
	private fetchSignature = '';

	constructor(private readonly plugin: GanttCalendarPlugin) {}

	/** 设置变化 / 启动时调用：按配置重排定时器，必要时重新拉取或仅重新着色 */
	applyConfig(): void {
		const config = getIcsConfig(this.plugin);

		if (config.syncInterval !== this.interval) {
			this.stopTimer();
			this.interval = config.syncInterval;
			if (this.interval > 0) {
				this.timer = window.setInterval(() => {
					this.refresh({ silent: true }).catch((e) => Logger.error('IcsService', 'Auto refresh failed', e));
				}, this.interval * 60 * 1000);
			}
		}

		const signature = this.activeSubscriptions(config).map((s) => s.url.trim()).join('\n');
		if (signature !== this.fetchSignature) {
			this.fetchSignature = signature;
			this.refresh({ silent: true }).catch((e) => Logger.error('IcsService', 'Refresh failed', e));
		} else {
			this.rebuild(config); // 仅名称/颜色变化：用缓存重新着色
		}
	}

	/** 重新拉取全部启用的订阅 */
	async refresh(options?: { silent?: boolean }): Promise<void> {
		const config = getIcsConfig(this.plugin);
		const active = this.activeSubscriptions(config);
		this.fetchSignature = active.map((s) => s.url.trim()).join('\n');
		const errors: string[] = [];

		await Promise.all(active.map(async (sub) => {
			try {
				this.lastGood.set(sub.url, await this.fetch(sub.url));
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				errors.push(`${sub.name.trim() || sub.url}: ${msg}${this.lastGood.has(sub.url) ? ` (${i18n.t('settings.ics.usingCache')})` : ''}`);
				Logger.error('IcsService', `Failed to fetch ${sub.url}`, error);
			}
		}));

		const count = this.rebuild(config);

		if (errors.length > 0) {
			new Notice(`${i18n.t('settings.ics.syncFailed')}\n${errors.join('\n')}`, 10000);
		} else if (!options?.silent) {
			new Notice(active.length === 0 ? i18n.t('settings.ics.noSubscriptions') : i18n.t('settings.ics.syncDone', { count }));
		}
	}

	destroy(): void {
		this.stopTimer();
		useCalendarStore.getState().setIcsEvents([]);
	}

	private activeSubscriptions(config: IcsConfiguration): IcsSubscription[] {
		return config.subscriptions.filter((s) => s.enabled && s.url.trim());
	}

	private stopTimer(): void {
		if (this.timer) {
			window.clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	private async fetch(url: string): Promise<string> {
		const res = await requestUrl({ url: normalizeIcsUrl(url), method: 'GET', throw: false, headers: { 'Cache-Control': 'no-cache' } });
		if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
		if (!res.text.includes('BEGIN:VCALENDAR')) throw new Error(i18n.t('settings.ics.notIcs'));
		return res.text;
	}

	/** 用缓存文本解析出事件并推入 store，返回事件数 */
	private rebuild(config: IcsConfiguration): number {
		const now = Date.now();
		const winStart = new Date(now - PAST_DAYS * DAY_MS);
		const winEnd = new Date(now + FUTURE_DAYS * DAY_MS);
		const events: IcsCalendarEvent[] = [];

		for (const sub of this.activeSubscriptions(config)) {
			const text = this.lastGood.get(sub.url);
			if (!text) continue;
			const calendarName = sub.name.trim() || sub.url;
			for (const ev of parseIcs(text, winStart, winEnd)) {
				events.push({ ...ev, summary: ev.summary || i18n.t('settings.ics.untitled'), calendarId: sub.id, calendarName, color: sub.color });
			}
		}
		useCalendarStore.getState().setIcsEvents(events);
		return events.length;
	}
}
