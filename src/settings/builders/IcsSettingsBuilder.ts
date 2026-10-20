/* eslint-disable @typescript-eslint/no-misused-promises -- 动态 settings API 回调中使用 async 函数 */
import { Setting } from 'obsidian';
import { BaseBuilder } from './BaseBuilder';
import type { IcsConfiguration, SyncConfiguration } from '../types';
import { ICS_DEFAULT_COLORS, getIcsConfig } from '../../data-layer/ics/IcsService';
import { i18n } from '../../i18n/i18n';

const INTERVAL_OPTIONS = [0, 15, 30, 60, 180, 720, 1440];

/**
 * ICS 日历订阅设置（同步页的第二个模块，与飞书同步互相独立）
 */
export class IcsSettingsBuilder extends BaseBuilder {
	render(): void {
		this.createSettingGroup(i18n.t('settings.ics.groupTitle'), (group) => {
			const add = (cb: (setting: Setting) => void) => group.addSetting(cb);
			const config = getIcsConfig(this.plugin);

			add(s => s.setDesc(i18n.t('settings.ics.description')));

			config.subscriptions.forEach((sub, index) => {
				add(s => s
					.setName(i18n.t('settings.ics.subscription', { index: index + 1 }))
					.addText(t => t
						.setPlaceholder(i18n.t('settings.ics.namePlaceholder'))
						.setValue(sub.name)
						.onChange(async (v) => {
							sub.name = v;
							await this.save(config);
						}))
					.addText(t => t
						.setPlaceholder('https://example.com/calendar.ics')
						.setValue(sub.url)
						.onChange(async (v) => {
							sub.url = v.trim();
							await this.save(config);
						}))
					.addColorPicker(c => c
						.setValue(sub.color)
						.onChange(async (v) => {
							sub.color = v;
							await this.save(config);
						}))
					.addToggle(t => t
						.setValue(sub.enabled)
						.setTooltip(i18n.t('settings.ics.enabled'))
						.onChange(async (v) => {
							sub.enabled = v;
							await this.save(config);
						}))
					.addExtraButton(b => b
						.setIcon('trash')
						.setTooltip(i18n.t('settings.ics.remove'))
						.onClick(async () => {
							config.subscriptions.splice(index, 1);
							await this.save(config);
							this.onRefreshSettings?.();
						})));
			});

			add(s => s
				.setName(i18n.t('settings.ics.add.name'))
				.addButton(b => b
					.setButtonText(i18n.t('settings.ics.add.button'))
					.onClick(async () => {
						config.subscriptions.push({ id: `ics-${Date.now()}`, name: '', url: '', color: ICS_DEFAULT_COLORS[config.subscriptions.length % ICS_DEFAULT_COLORS.length], enabled: true });
						await this.save(config);
						this.onRefreshSettings?.();
					})));

			add(s => s
				.setName(i18n.t('settings.ics.interval.name'))
				.setDesc(i18n.t('settings.ics.interval.description'))
				.addDropdown(d => {
					for (const minutes of INTERVAL_OPTIONS) {
						d.addOption(String(minutes), minutes === 0 ? i18n.t('settings.ics.interval.off') : i18n.t('settings.ics.interval.minutes', { minutes }));
					}
					d.setValue(String(config.syncInterval)).onChange(async (v) => {
						config.syncInterval = Number(v);
						await this.save(config);
					});
				}));

			add(s => s
				.setName(i18n.t('settings.ics.syncNow.name'))
				.setDesc(i18n.t('settings.ics.syncNow.description'))
				.addButton(b => b
					.setButtonText(i18n.t('settings.ics.syncNow.button'))
					.setClass('mod-cta')
					.onClick(async () => {
						await this.plugin.icsService.refresh();
					})));
		});
	}

	private async save(config: IcsConfiguration): Promise<void> {
		const current: SyncConfiguration = this.plugin.settings.syncConfiguration ?? {
			enabledSources: {},
			syncDirection: 'bidirectional',
			syncInterval: 30,
			conflictResolution: 'local-win',
			feishuSyncTargetFile: 'gantt-calendar-feishu-sync.md',
		};
		this.plugin.settings.syncConfiguration = { ...current, ics: config };
		await this.plugin.saveSettings();
	}
}
/* eslint-enable @typescript-eslint/no-misused-promises -- 末尾：恢复对 settings 回调中 async 函数的检查 */
