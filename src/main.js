// PDF Compressor settings page: the controls, and what has been compressed so far.

const MIB = 1024 * 1024;
const mib = bytes => `${(bytes / MIB).toFixed(1)} MiB`;
const baseName = file => file.split(/[\\/]/).pop();

const OUTCOME = {
	compressed: entry => `${mib(entry.originalBytes)} → ${mib(entry.compressedBytes)} · ${entry.preset}`,
	over: entry => `${mib(entry.originalBytes)} → ${mib(entry.compressedBytes)} · ${entry.preset} · still over the limit`,
	unchanged: entry => `${mib(entry.originalBytes)} · could not be made smaller`,
	failed: entry => `${mib(entry.originalBytes)} · failed: ${entry.message}`,
};

function element(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export function activate(ctx) {
	ctx.registerSettings(async (container, signal) => {
		const root = element("div", "pdf-compressor");
		const rowsHost = element("div");
		const heading = element("h3", "pdf-compressor-heading", "Activity");
		const status = element("p", "pdf-compressor-status");
		const scanHost = element("div");
		const list = element("ul", "pdf-compressor-list");
		root.append(rowsHost, heading, status, scanHost, list);
		container.append(root);

		let state = await ctx.call("state");
		if (signal.aborted) return;

		const save = key => async value => {
			state = await ctx.call("save-settings", { [key]: value });
			paint();
		};
		const rows = () => [
			{
				type: "number",
				key: "thresholdMiB",
				label: "Size limit (MiB)",
				description: "PDFs larger than this are compressed. LearnHarness itself refuses documents over 25 MiB.",
				value: state.settings.thresholdMiB,
				min: 1,
				max: 10000,
				step: 1,
				onChange: save("thresholdMiB"),
			},
			{
				type: "dropdown",
				key: "strongest",
				label: "Lowest quality allowed",
				description: "The gentlest setting that gets under the limit is used, never going below this one.",
				value: state.settings.strongest,
				options: [
					{ value: "lossless", label: "Lossless only (images untouched)" },
					{ value: "high", label: "High (200 dpi)" },
					{ value: "medium", label: "Medium (150 dpi)" },
					{ value: "low", label: "Low (96 dpi)" },
				],
				onChange: save("strongest"),
			},
			{
				type: "dropdown",
				key: "mode",
				label: "Compressed file",
				description: "Replaced originals are kept in this plugin's data folder under originals/.",
				value: state.settings.mode,
				options: [
					{ value: "copy", label: "Save a .compressed.pdf copy beside the original" },
					{ value: "replace", label: "Replace the original" },
				],
				onChange: save("mode"),
			},
			{
				type: "text",
				key: "folders",
				label: "Watched folders",
				description:
					"Optional. PDFs in these folders are compressed as soon as they appear. Separate folders with ; (for example ~/Downloads; ~/Documents/Textbooks).",
				value: state.settings.folders.join("; "),
				onChange: save("folders"),
			},
		];

		const settingsRows = ctx.ui.mountSettingsRows(rowsHost, { rows: rows() }, { signal });
		const scanButton = ctx.ui.mountButton(
			scanHost,
			{
				label: "Scan watched folders now",
				variant: "outline",
				size: "sm",
				onClick: async () => {
					await ctx.call("scan");
					await refresh();
				},
			},
			{ signal },
		);

		function paint() {
			settingsRows.update({ rows: rows() });
			scanButton.update({ disabled: state.settings.folders.length === 0 });
			const watching = state.settings.folders.length
				? `Watching ${state.settings.folders.length} folder${state.settings.folders.length === 1 ? "" : "s"}.`
				: "No watched folders.";
			status.textContent = state.current
				? `Compressing ${baseName(state.current)}…${state.waiting ? ` ${state.waiting} more waiting.` : ""}`
				: `PDFs the teacher is asked to read are checked automatically. ${watching}`;
			list.replaceChildren(
				...state.problems.map(problem => element("li", "pdf-compressor-problem", problem)),
				...state.history.map(entry => {
					const item = element("li");
					item.title = entry.output ?? entry.source;
					item.append(
						element("span", "pdf-compressor-name", baseName(entry.source)),
						element("span", `pdf-compressor-outcome pdf-compressor-${entry.status}`, OUTCOME[entry.status]?.(entry) ?? entry.status),
						element("span", "pdf-compressor-when", new Date(entry.at).toLocaleString()),
					);
					return item;
				}),
			);
			if (!list.children.length) list.append(element("li", "pdf-compressor-empty", "Nothing has needed compressing yet."));
		}

		async function refresh() {
			const next = await ctx.call("state");
			if (signal.aborted) return;
			state = next;
			paint();
		}

		paint();
		const stopNotifications = ctx.onNotification(event => {
			if (event.topic === "changed") refresh().catch(() => {});
		});
		const stopResync = ctx.onResync(() => refresh().catch(() => {}));
		return () => {
			stopNotifications();
			stopResync();
			root.remove();
		};
	});
}
