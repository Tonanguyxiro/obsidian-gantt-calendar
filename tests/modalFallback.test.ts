/** @jest-environment jsdom */
/**
 * Modal 进场可见性兜底测试。
 *
 * 覆盖的 bug：motion 的 rAF 在后台 / 无头环境不触发，进场动画停在 initial
 * （opacity:0），弹窗已挂载但看不见；300ms 兜底把仍为 0 的 overlay/panel
 * 写成 inline opacity:1，关闭动画与 motion 变体不受影响。
 */
import { ensureModalVisible } from '../src/ui/components/Modal';
import { setCssProps } from '../src/utils/bem';

describe('Modal 进场可见性兜底', () => {
	test('遮罩与面板仍为 opacity:0 时强制写成 1', () => {
		const overlay = document.createElement('div');
		const panel = document.createElement('div');
		setCssProps(overlay, { opacity: '0' });
		setCssProps(panel, { opacity: '0' });
		document.body.append(overlay, panel);

		ensureModalVisible(overlay, panel);

		expect(overlay.style.opacity).toBe('1');
		expect(panel.style.opacity).toBe('1');
	});

	test('已在动画中（opacity 非 0）不覆盖 motion 的 inline 值', () => {
		const overlay = document.createElement('div');
		setCssProps(overlay, { opacity: '0.5' });
		const panel = document.createElement('div');
		setCssProps(panel, { opacity: '1' });

		ensureModalVisible(overlay, panel);

		expect(overlay.style.opacity).toBe('0.5');
		expect(panel.style.opacity).toBe('1');
	});

	test('空引用不抛错（ref 尚未挂载 / 已卸载）', () => {
		expect(() => ensureModalVisible(null, null)).not.toThrow();
		const panel = document.createElement('div');
		setCssProps(panel, { opacity: '0' });
		expect(() => ensureModalVisible(null, panel)).not.toThrow();
		expect(panel.style.opacity).toBe('1');
	});
});
