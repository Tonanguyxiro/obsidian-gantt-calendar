import { memo, type CSSProperties, type JSX } from 'react';
import type { GCTask } from '../../types';
import { IcsEventClasses } from '../../utils/bem';
import { formatDate } from '../../dateUtils/dateUtilsIndex';

/**
 * ICS 订阅事件卡片：只读（无勾选、拖动、右键菜单、编辑），颜色取自订阅设置
 */
export const IcsEventCard = memo(function IcsEventCard({ task }: { task: GCTask }): JSX.Element | null {
	const info = task.icsEvent;
	if (!info) return null;

	const start = task.startDate ?? task.scheduledDate ?? task.dueDate;
	const end = task.dueDate ?? start;
	const when = info.allDay || !start
		? ''
		: `${formatDate(start, 'HH:mm')}${end && end.getTime() !== start.getTime() ? ` - ${formatDate(end, 'HH:mm')}` : ''}`;
	const title = [task.description, when, info.location, info.calendarName].filter(Boolean).join('\n');

	return (
		<div
			className={IcsEventClasses.block}
			style={{ '--gc-ics-color': info.color } as CSSProperties}
			title={title}
			data-ics-event={task.filePath}
		>
			<span className={IcsEventClasses.elements.title}>{task.description}</span>
			{info.location ? <span className={IcsEventClasses.elements.location}>{info.location}</span> : null}
		</div>
	);
});
