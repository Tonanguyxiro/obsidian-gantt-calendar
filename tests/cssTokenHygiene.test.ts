import { Platform } from 'obsidian';

let fsMod: typeof import('node:fs');
let pathMod: typeof import('node:path');
let stylesDir = '';

function collectCssFiles(dir: string): string[] {
	const result: string[] = [];
	for (const entry of fsMod.readdirSync(dir, { withFileTypes: true })) {
		const full = pathMod.join(dir, entry.name);
		if (entry.isDirectory()) {
			result.push(...collectCssFiles(full));
		} else if (entry.isFile() && entry.name.endsWith('.css')) {
			result.push(full);
		}
	}
	return result.sort();
}

describe('CSS 设计令牌与响应式排版卫生检查', () => {
	let cssFiles: string[] = [];

	beforeAll(async () => {
		if (!Platform.isDesktop) {
			throw new Error('CSS hygiene test requires desktop Node environment');
		}
		fsMod = await import('node:fs');
		pathMod = await import('node:path');
		stylesDir = pathMod.resolve('src/styles');
		cssFiles = collectCssFiles(stylesDir);
	});

	it('src/styles/**/*.css 中硬编码颜色字面量总计 < 20', () => {
		const colorRegex = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g;
		let totalMatches = 0;

		for (const file of cssFiles) {
			const content = fsMod.readFileSync(file, 'utf8');
			const matches = content.match(colorRegex);
			if (matches) {
				totalMatches += matches.length;
			}
		}

		expect(cssFiles.length).toBeGreaterThan(0);
		expect(totalMatches).toBeLessThan(20);
	});

	it('tokens.css 中所有 --gc-font-* 令牌均使用 clamp()', () => {
		const tokensPath = pathMod.join(stylesDir, 'tokens.css');
		const tokensCss = fsMod.readFileSync(tokensPath, 'utf8');

		const requiredFontTokens = [
			'--gc-font-2xs',
			'--gc-font-xxs',
			'--gc-font-xs',
			'--gc-font-sm',
			'--gc-font-md',
			'--gc-font-lg',
			'--gc-font-xl',
		];

		for (const token of requiredFontTokens) {
			const defRegex = new RegExp(`${token}\\s*:\\s*([^;]+);`);
			const match = tokensCss.match(defRegex);
			expect(match).not.toBeNull();
			expect(match![1]).toContain('clamp(');
		}

		const allFontTokens = Array.from(tokensCss.matchAll(/(--gc-font-[a-z0-9-]+)\s*:\s*([^;]+);/g));
		expect(allFontTokens.length).toBeGreaterThanOrEqual(requiredFontTokens.length);
		for (const [, , value] of allFontTokens) {
			expect(value).toContain('clamp(');
		}
	});

	it('tokens.css 将 --gc-color-* 等主题衍生变量声明在 body（非 :root），以正确解析 Obsidian 变量', () => {
		const tokensPath = pathMod.join(stylesDir, 'tokens.css');
		const tokensCss = fsMod.readFileSync(tokensPath, 'utf8');
		const bodyBlockMatch = tokensCss.match(/\bbody\s*\{([\s\S]*?)\}/);
		expect(bodyBlockMatch).not.toBeNull();
		const bodyBlock = bodyBlockMatch![1];
		expect(bodyBlock).toContain('--gc-color-red: var(--color-red)');
		expect(bodyBlock).toContain('--gc-today: var(--color-red)');
		expect(bodyBlock).toContain('--gc-heat-blue: var(--color-blue)');
	});

	it('src/styles/**/*.css 中固定 px font-size 声明已清零，并保留关键约束规则', () => {
		const fixedPxFontRegex = /\bfont-size\s*:\s*\d+(?:\.\d+)?px\b/g;
		const fixedMatches: string[] = [];

		for (const file of cssFiles) {
			const content = fsMod.readFileSync(file, 'utf8');
			const matches = content.match(fixedPxFontRegex);
			if (matches) {
				fixedMatches.push(`${pathMod.relative(stylesDir, file)}: ${matches.join(', ')}`);
			}
		}

		expect(fixedMatches).toEqual([]);

		// 保留 .gc-week-view__time-block-time ≤ 10px 约束与行高 1.3
		const weekViewCss = fsMod.readFileSync(pathMod.join(stylesDir, 'views/week-view.css'), 'utf8');
		expect(weekViewCss).toMatch(/\.gc-week-view__time-block-time\s*\{[^}]*font-size:\s*var\(--gc-font-2xs\);[^}]*line-height:\s*1\.3;/s);

		// 保留移动端月视图色带的 font-size: 0
		const monthViewCss = fsMod.readFileSync(pathMod.join(stylesDir, 'views/month-view.css'), 'utf8');
		expect(monthViewCss).toMatch(/\.gc-month-view__span-bar\s*\{[^}]*font-size:\s*0;/s);
	});
});
