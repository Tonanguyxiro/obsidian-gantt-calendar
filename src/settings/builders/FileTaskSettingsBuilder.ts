import { BaseBuilder } from './BaseBuilder';
import { FolderSuggest } from '../components';
import type { BuilderConfig, FileTaskViewKey } from '../types';
import { i18n } from '../../i18n/i18n';

const VIEW_KEYS: FileTaskViewKey[] = ['day', 'week', 'month', 'gantt'];

/**
 * File-based task 设置构建器
 * 识别规则（起止/项目属性、范围文件夹）+ 各视图的显示与归类选项
 */
export class FileTaskSettingsBuilder extends BaseBuilder {
	constructor(config: BuilderConfig) {
		super(config);
	}

	render(): void {
		this.createSettingGroup(i18n.t('settings.fileTasks.groupTitle'), (group) => {
			const settings = this.plugin.settings;
			const toggle = (
				key: 'fileTaskIncludeDated' | 'fileTaskIncludeTaskFiles' | 'fileTaskExcludeDailyNotes',
				i18nKey: string,
				restructure: boolean,
			) => {
				group.addSetting(setting => {
					setting.setName(i18n.t(`settings.fileTasks.${i18nKey}.name`))
						.setDesc(i18n.t(`settings.fileTasks.${i18nKey}.description`))
						.addToggle(t => t
							.setValue(settings[key])
							.onChange(async (value) => {
								settings[key] = value;
								// 来源开关会显隐其子选项，需要重建设置页
								if (restructure) await this.saveAndRefreshAll();
								else await this.saveAndRefreshViews();
							}));
				});
			};

			// 来源 1：带日期属性的文件（Timeline for Bases 式）+ 标签过滤
			toggle('fileTaskIncludeDated', 'includeDated', true);
			if (settings.fileTaskIncludeDated) {
				group.addSetting(setting => {
					setting.setName(i18n.t('settings.fileTasks.requiredTags.name'))
						.setDesc(i18n.t('settings.fileTasks.requiredTags.description'))
						.addText(text => text
							.setPlaceholder('Project, area/work')
							.setValue(settings.fileTaskRequiredTags)
							.onChange(async (value) => {
								settings.fileTaskRequiredTags = value;
								await this.saveAndRefreshViews();
							}));
				});
			}

			// 来源 2：含任务的文件（无日期属性时用任务日期）+ 排除每日笔记
			toggle('fileTaskIncludeTaskFiles', 'includeTaskFiles', true);
			if (settings.fileTaskIncludeTaskFiles) {
				toggle('fileTaskExcludeDailyNotes', 'excludeDailyNotes', false);
			}

			const textProp = (key: 'fileTaskStartProperty' | 'fileTaskEndProperty' | 'fileTaskProjectProperty', i18nKey: string, placeholder: string) => {
				group.addSetting(setting => {
					setting.setName(i18n.t(`settings.fileTasks.${i18nKey}.name`))
						.setDesc(i18n.t(`settings.fileTasks.${i18nKey}.description`))
						.addText(text => text
							.setPlaceholder(placeholder)
							.setValue(settings[key])
							.onChange(async (value) => {
								settings[key] = value.trim();
								await this.saveAndRefreshViews();
							}));
				});
			};
			textProp('fileTaskStartProperty', 'startProperty', 'start');
			textProp('fileTaskEndProperty', 'endProperty', 'end');
			textProp('fileTaskProjectProperty', 'projectProperty', 'project');

			group.addSetting(setting => {
				setting.setName(i18n.t('settings.fileTasks.folder.name'))
					.setDesc(i18n.t('settings.fileTasks.folder.description'))
					.addSearch(cb => {
						new FolderSuggest(this.plugin.app, cb.inputEl);
						cb.setPlaceholder('Projects')
							.setValue(settings.fileTaskFolder)
							.onChange(async (value) => {
								settings.fileTaskFolder = value.trim();
								await this.saveAndRefreshViews();
							});
					});
			});

			// 各视图：显示 file-based task / 把文件内任务归入文件
			for (const view of VIEW_KEYS) {
				group.addSetting(setting => {
					setting.setName(i18n.t(`settings.fileTasks.views.${view}`))
						.setDesc(i18n.t(view === 'gantt' ? 'settings.fileTasks.views.ganttDescription' : 'settings.fileTasks.views.calendarDescription'))
						.addToggle(toggle => toggle
							.setTooltip(i18n.t('settings.fileTasks.views.show'))
							.setValue(settings.fileTaskViews[view].show)
							.onChange(async (value) => {
								settings.fileTaskViews[view] = { ...settings.fileTaskViews[view], show: value };
								await this.saveAndRefreshViews();
							}))
						.addToggle(toggle => toggle
							.setTooltip(i18n.t('settings.fileTasks.views.groupTasks'))
							.setValue(settings.fileTaskViews[view].groupTasks)
							.onChange(async (value) => {
								settings.fileTaskViews[view] = { ...settings.fileTaskViews[view], groupTasks: value };
								await this.saveAndRefreshViews();
							}));
				});
			}
		});
	}
}
