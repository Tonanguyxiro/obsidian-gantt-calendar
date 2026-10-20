/**
 * ICS 日历订阅相关命令
 */

import type GanttCalendarPlugin from '../../main';
import { i18n } from '../i18n/i18n';

export function registerIcsCommands(plugin: GanttCalendarPlugin): void {
	plugin.addCommand({
		id: 'ics-sync-subscriptions',
		name: i18n.t('commands.icsSync'),
		callback: async () => {
			await plugin.icsService.refresh();
		}
	});
}
