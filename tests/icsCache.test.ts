/** @jest-environment jsdom */
import {
	ICS_CACHE_VERSION,
	loadIcsCache,
	parseIcsCache,
	resolveIcsCachePath,
	saveIcsCache,
	type IcsCacheData,
	type IcsCachePluginContext,
} from '../src/data-layer/ics/icsCache';
import { IcsService } from '../src/data-layer/ics/IcsService';
import type GanttCalendarPlugin from '../main';
import { useCalendarStore } from '../src/ui/store/calendarStore';

const mockRequestUrl = jest.fn<Promise<{ status: number; text: string }>, unknown[]>();

jest.mock('obsidian', () => {
	const actual = jest.requireActual<typeof import('./__mocks__/obsidian')>('./__mocks__/obsidian');
	return {
		...actual,
		requestUrl: (...args: unknown[]) => mockRequestUrl(...args),
	};
});

const TEST_PLUGIN_DIR = 'test-config/plugins/gantt-calendar';
const TEST_CACHE_PATH = `${TEST_PLUGIN_DIR}/ics-cache.json`;

function formatIcsDate(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}${m}${d}`;
}

function makeSampleIcs(summary: string, offsetDays = 1): string {
	const start = new Date();
	start.setDate(start.getDate() + offsetDays);
	const end = new Date(start);
	end.setDate(end.getDate() + 1);
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'BEGIN:VEVENT',
		`UID:${summary}-${offsetDays}`,
		`SUMMARY:${summary}`,
		`DTSTART;VALUE=DATE:${formatIcsDate(start)}`,
		`DTEND;VALUE=DATE:${formatIcsDate(end)}`,
		'END:VEVENT',
		'END:VCALENDAR',
	].join('\r\n');
}

function createMemoryAdapter(initial: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initial));
	const exists = jest.fn(async (path: string) => files.has(path));
	const read = jest.fn(async (path: string) => {
		const val = files.get(path);
		if (val === undefined) throw new Error(`ENOENT: ${path}`);
		return val;
	});
	const write = jest.fn(async (path: string, data: string) => {
		files.set(path, data);
	});
	const mkdir = jest.fn(async () => {});
	return { files, adapter: { exists, read, write, mkdir } };
}

function createMockPlugin(
	adapter: ReturnType<typeof createMemoryAdapter>['adapter'],
	subscriptions: Array<{ id: string; name: string; url: string; color: string; enabled: boolean }>,
	manifestDir: string | undefined = TEST_PLUGIN_DIR,
	configDir = 'test-config',
): GanttCalendarPlugin {
	return {
		app: {
			vault: {
				configDir,
				adapter,
			},
		},
		manifest: {
			id: 'gantt-calendar',
			dir: manifestDir,
		},
		settings: {
			syncConfiguration: {
				enabledSources: {},
				syncDirection: 'bidirectional',
				syncInterval: 30,
				conflictResolution: 'local-win',
				feishuSyncTargetFile: 'sync.md',
				ics: {
					subscriptions,
					syncInterval: 0,
				},
			},
		},
	} as unknown as GanttCalendarPlugin;
}

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('icsCache', () => {
	it('resolves cache path using manifest.dir and falls back to vault.configDir', () => {
		const { adapter } = createMemoryAdapter();
		const withManifestDir: IcsCachePluginContext = {
			app: { vault: { configDir: 'test-config', adapter } },
			manifest: { id: 'gantt-calendar', dir: `${TEST_PLUGIN_DIR}/` },
		};
		expect(resolveIcsCachePath(withManifestDir)).toBe(TEST_CACHE_PATH);

		const fallbackConfigDir: IcsCachePluginContext = {
			app: { vault: { configDir: 'custom-vault-cfg', adapter } },
			manifest: { id: 'gantt-calendar' },
		};
		expect(resolveIcsCachePath(fallbackConfigDir)).toBe('custom-vault-cfg/plugins/gantt-calendar/ics-cache.json');
	});

	it('parses valid versioned cache and gracefully rejects corrupt or mismatched payloads', () => {
		const validRaw = JSON.stringify({
			version: ICS_CACHE_VERSION,
			entries: {
				'https://example.com/a.ics': { text: 'BEGIN:VCALENDAR', fetchedAt: 1700000000000 },
				'https://example.com/bad-text': { text: 123, fetchedAt: 1700000000000 },
				'https://example.com/bad-time': { text: 'BEGIN:VCALENDAR', fetchedAt: 'NaN' },
			},
		});
		expect(parseIcsCache(validRaw)).toEqual({
			version: ICS_CACHE_VERSION,
			entries: {
				'https://example.com/a.ics': { text: 'BEGIN:VCALENDAR', fetchedAt: 1700000000000 },
			},
		});

		expect(parseIcsCache('{not-json')).toEqual({ version: ICS_CACHE_VERSION, entries: {} });
		expect(parseIcsCache(JSON.stringify({ version: 99, entries: { a: { text: 'x', fetchedAt: 1 } } }))).toEqual({
			version: ICS_CACHE_VERSION,
			entries: {},
		});
		expect(parseIcsCache('[]')).toEqual({ version: ICS_CACHE_VERSION, entries: {} });
	});

	it('returns empty cache when missing or when adapter read throws, and writes versioned JSON', async () => {
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const { files, adapter } = createMemoryAdapter();
		const plugin: IcsCachePluginContext = {
			app: { vault: { configDir: 'test-config', adapter } },
			manifest: { id: 'gantt-calendar', dir: TEST_PLUGIN_DIR },
		};

		expect(await loadIcsCache(plugin)).toEqual({ version: ICS_CACHE_VERSION, entries: {} });

		await saveIcsCache(plugin, {
			'https://example.com/a.ics': { text: 'ICS_DATA', fetchedAt: 42 },
		});
		const saved = files.get(TEST_CACHE_PATH);
		expect(saved).toBeDefined();
		expect(JSON.parse(saved!) as IcsCacheData).toEqual({
			version: ICS_CACHE_VERSION,
			entries: {
				'https://example.com/a.ics': { text: 'ICS_DATA', fetchedAt: 42 },
			},
		});

		adapter.read.mockRejectedValueOnce(new Error('disk error'));
		expect(await loadIcsCache(plugin)).toEqual({ version: ICS_CACHE_VERSION, entries: {} });
		warnSpy.mockRestore();
	});
});

describe('IcsService persistent cache integration', () => {
	beforeEach(() => {
		mockRequestUrl.mockReset();
		useCalendarStore.getState().setIcsEvents([]);
		jest.spyOn(console, 'error').mockImplementation(() => {});
		jest.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('hydrates cached events before network fetch completes and retains them when offline', async () => {
		const url = 'https://example.com/work.ics';
		const cachedIcs = makeSampleIcs('Cached Sprint Review', 2);
		const { files, adapter } = createMemoryAdapter({
			[TEST_CACHE_PATH]: JSON.stringify({
				version: ICS_CACHE_VERSION,
				entries: {
					[url]: { text: cachedIcs, fetchedAt: 1000 },
				},
			}),
		});

		let rejectFetch!: (err: Error) => void;
		mockRequestUrl.mockImplementationOnce(
			() => new Promise((_, reject) => { rejectFetch = reject; }),
		);

		const plugin = createMockPlugin(adapter, [
			{ id: 'sub-1', name: 'Work', url, color: '#4f8cff', enabled: true },
		]);
		const service = new IcsService(plugin);

		service.applyConfig();
		// Wait for disk cache hydration + immediate rebuild (network promise is still pending)
		await flushPromises();

		expect(useCalendarStore.getState().icsEvents.map((e) => e.summary)).toEqual(['Cached Sprint Review']);

		// Simulate offline failure
		rejectFetch(new Error('Network offline'));
		await flushPromises();

		expect(useCalendarStore.getState().icsEvents.map((e) => e.summary)).toEqual(['Cached Sprint Review']);
		const stored = JSON.parse(files.get(TEST_CACHE_PATH)!) as IcsCacheData;
		expect(stored.entries[url].text).toBe(cachedIcs);
		service.destroy();
	});

	it('updates cache after successful fetch and prunes URLs no longer configured', async () => {
		const activeUrl = 'https://example.com/active.ics';
		const removedUrl = 'https://example.com/removed.ics';
		const staleIcs = makeSampleIcs('Old Event', 1);
		const freshIcs = makeSampleIcs('Fresh Event', 3);

		const { files, adapter } = createMemoryAdapter({
			[TEST_CACHE_PATH]: JSON.stringify({
				version: ICS_CACHE_VERSION,
				entries: {
					[activeUrl]: { text: staleIcs, fetchedAt: 1000 },
					[removedUrl]: { text: staleIcs, fetchedAt: 1000 },
				},
			}),
		});

		mockRequestUrl.mockResolvedValueOnce({ status: 200, text: freshIcs });

		const plugin = createMockPlugin(adapter, [
			{ id: 'sub-1', name: 'Active', url: activeUrl, color: '#3fb950', enabled: true },
		]);
		const service = new IcsService(plugin);

		service.applyConfig();
		await flushPromises();

		expect(useCalendarStore.getState().icsEvents.map((e) => e.summary)).toEqual(['Fresh Event']);
		const persisted = JSON.parse(files.get(TEST_CACHE_PATH)!) as IcsCacheData;
		expect(persisted.version).toBe(ICS_CACHE_VERSION);
		expect(Object.keys(persisted.entries)).toEqual([activeUrl]);
		expect(persisted.entries[activeUrl].text).toBe(freshIcs);
		expect(typeof persisted.entries[activeUrl].fetchedAt).toBe('number');
		expect(persisted.entries[removedUrl]).toBeUndefined();

		service.destroy();
	});

	it('recovers gracefully from corrupt cache JSON and writes valid cache on fetch', async () => {
		const url = 'https://example.com/cal.ics';
		const freshIcs = makeSampleIcs('Recovered Event', 4);
		const { files, adapter } = createMemoryAdapter({
			[TEST_CACHE_PATH]: '<<<corrupt json>>>',
		});

		mockRequestUrl.mockResolvedValueOnce({ status: 200, text: freshIcs });

		const plugin = createMockPlugin(adapter, [
			{ id: 'sub-1', name: 'Cal', url, color: '#f5a623', enabled: true },
		]);
		const service = new IcsService(plugin);

		service.applyConfig();
		await flushPromises();

		expect(useCalendarStore.getState().icsEvents.map((e) => e.summary)).toEqual(['Recovered Event']);
		const persisted = JSON.parse(files.get(TEST_CACHE_PATH)!) as IcsCacheData;
		expect(persisted.version).toBe(ICS_CACHE_VERSION);
		expect(persisted.entries[url].text).toBe(freshIcs);

		service.destroy();
	});

	it('recolors cached events on name/color change without extra network fetch', async () => {
		const url = 'https://example.com/cal.ics';
		const ics = makeSampleIcs('Team Sync', 2);
		const { adapter } = createMemoryAdapter({
			[TEST_CACHE_PATH]: JSON.stringify({
				version: ICS_CACHE_VERSION,
				entries: {
					[url]: { text: ics, fetchedAt: 1000 },
				},
			}),
		});

		mockRequestUrl.mockResolvedValueOnce({ status: 200, text: ics });

		const subscriptions = [
			{ id: 'sub-1', name: 'Old Name', url, color: '#4f8cff', enabled: true },
		];
		const plugin = createMockPlugin(adapter, subscriptions);
		const service = new IcsService(plugin);

		service.applyConfig();
		await flushPromises();
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);

		subscriptions[0] = { id: 'sub-1', name: 'New Name', url, color: '#e5484d', enabled: true };
		service.applyConfig();

		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
		expect(useCalendarStore.getState().icsEvents[0]).toMatchObject({
			calendarName: 'New Name',
			color: '#e5484d',
		});

		service.destroy();
	});
});
