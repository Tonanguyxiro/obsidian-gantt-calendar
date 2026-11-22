/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Modal, getFocusableElements } from '../src/ui/components/Modal';
import { ModalClasses } from '../src/utils/bem';

function makeDiv(cls?: string): HTMLDivElement {
	const frag = document.createRange().createContextualFragment('<div></div>');
	const el = frag.firstElementChild as HTMLDivElement;
	if (cls) el.className = cls;
	return el;
}

function dispatchTab(shiftKey = false): KeyboardEvent {
	const evt = new KeyboardEvent('keydown', {
		key: 'Tab',
		shiftKey,
		bubbles: true,
		cancelable: true,
	});
	document.dispatchEvent(evt);
	return evt;
}

describe('Modal 焦点捕获 (Focus Trap)', () => {
	let host: HTMLElement;
	let root: Root;

	beforeAll(() => {
		(window as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	});

	beforeEach(() => {
		host = makeDiv();
		document.body.appendChild(host);
		root = createRoot(host);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		host.remove();
		document.body.replaceChildren();
	});

	test('getFocusableElements 仅收集可见且启用的可聚焦元素', () => {
		const frag = document.createRange().createContextualFragment(`
			<div>
				<button id="btn-ok">OK</button>
				<button id="btn-disabled" disabled>Disabled</button>
				<input id="inp-text" type="text" />
				<input id="inp-hidden" type="hidden" />
				<a id="link-ok" href="#top">Link</a>
				<a id="link-nohref">NoHref</a>
				<div id="tab-neg" tabindex="-1">Neg</div>
				<div id="tab-zero" tabindex="0">Zero</div>
				<div id="ce-true" contenteditable="true">Editable</div>
				<div id="hidden-attr" hidden><button id="inside-hidden">Hidden</button></div>
				<div id="aria-hidden" aria-hidden="true"><button id="inside-aria">AriaHidden</button></div>
				<div id="disp-none" style="display: none"><button id="inside-disp">DispNone</button></div>
				<div id="vis-hidden" style="visibility: hidden"><button id="inside-vis">VisHidden</button></div>
				<fieldset disabled><button id="inside-fieldset">Fieldset</button></fieldset>
			</div>
		`);
		const container = frag.firstElementChild as HTMLElement;
		document.body.appendChild(container);

		const ids = getFocusableElements(container).map((el) => el.id);
		expect(ids).toEqual(['btn-ok', 'inp-text', 'link-ok', 'tab-zero', 'ce-true']);
	});

	test('打开时聚焦面板并归还触发焦点；Tab/Shift+Tab 在首尾之间循环包裹', async () => {
		const triggerFrag = document.createRange().createContextualFragment('<button id="trigger">Open</button>');
		const trigger = triggerFrag.firstElementChild as HTMLButtonElement;
		document.body.appendChild(trigger);
		trigger.focus();
		expect(document.activeElement).toBe(trigger);

		const onClose = jest.fn();
		await act(async () => {
			root.render(
				createElement(Modal, {
					open: true,
					onClose,
					title: 'Trap Test',
					children: [
						createElement('input', { key: 'i', id: 'first-input', type: 'text' }),
						createElement('button', { key: 'b', id: 'last-btn', type: 'button' }, 'Save'),
					],
				})
			);
		});

		const panel = document.body.querySelector(`.${ModalClasses.panel}`) as HTMLElement;
		const closeBtn = document.body.querySelector(`.${ModalClasses.closeBtn}`) as HTMLButtonElement;
		const firstInput = document.getElementById('first-input') as HTMLInputElement;
		const lastBtn = document.getElementById('last-btn') as HTMLButtonElement;

		expect(panel).not.toBeNull();
		expect(document.activeElement).toBe(panel);

		// 从 panel 本身按 Tab → 跳到第一个可聚焦元素（closeBtn）
		const tabFromPanel = dispatchTab(false);
		expect(tabFromPanel.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(closeBtn);

		// 从 first 按 Shift+Tab → 回绕到 lastBtn
		const shiftTabFromFirst = dispatchTab(true);
		expect(shiftTabFromFirst.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(lastBtn);

		// 从 last 按 Tab → 回绕到 first（closeBtn）
		const tabFromLast = dispatchTab(false);
		expect(tabFromLast.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(closeBtn);

		// 中间元素不拦截默认 Tab
		firstInput.focus();
		const tabFromMiddle = dispatchTab(false);
		expect(tabFromMiddle.defaultPrevented).toBe(false);

		// 从外部元素按 Tab / Shift+Tab 拉回弹窗内
		trigger.focus();
		const tabFromOutside = dispatchTab(false);
		expect(tabFromOutside.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(closeBtn);

		trigger.focus();
		const shiftTabFromOutside = dispatchTab(true);
		expect(shiftTabFromOutside.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(lastBtn);

		// 关闭后焦点归还触发按钮
		await act(async () => {
			root.render(
				createElement(Modal, {
					open: false,
					onClose,
					title: 'Trap Test',
					children: createElement('span', null, 'closed'),
				})
			);
		});
		expect(document.activeElement).toBe(trigger);
	});

	test('焦点位于弹窗外置 .gc-popover 或 .suggestion-container 内时不劫持 Tab', async () => {
		const popFrag = document.createRange().createContextualFragment('<div class="gc-popover"><button id="pop-btn">Pick</button></div>');
		const sugFrag = document.createRange().createContextualFragment('<div class="suggestion-container"><button id="sug-btn">Sug</button></div>');
		const popover = popFrag.firstElementChild as HTMLElement;
		const suggest = sugFrag.firstElementChild as HTMLElement;
		document.body.append(popover, suggest);

		await act(async () => {
			root.render(
				createElement(Modal, {
					open: true,
					onClose: jest.fn(),
					title: 'Popover Test',
					children: createElement('input', { id: 'modal-input', type: 'text' }),
				})
			);
		});

		const popBtn = document.getElementById('pop-btn') as HTMLButtonElement;
		popBtn.focus();
		const evt1 = dispatchTab(false);
		expect(evt1.defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(popBtn);

		const sugBtn = document.getElementById('sug-btn') as HTMLButtonElement;
		sugBtn.focus();
		const evt2 = dispatchTab(true);
		expect(evt2.defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(sugBtn);
	});

	test('无任何可聚焦子元素时按 Tab 仍将焦点留在面板自身', async () => {
		await act(async () => {
			root.render(
				createElement(Modal, {
					open: true,
					onClose: jest.fn(),
					children: createElement('p', null, 'Readonly notice'),
				})
			);
		});

		const panel = document.body.querySelector(`.${ModalClasses.panel}`) as HTMLElement;
		const evt = dispatchTab(false);
		expect(evt.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(panel);
	});
});
