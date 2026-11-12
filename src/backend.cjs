"use strict";
// PDF Compressor backend. All compression is done by the bundled `pdf-shrink`
// binary (a separate Rust project); this file decides when to run it and where
// the result goes.

const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MIB = 1024 * 1024;
const PRESETS = ["lossless", "high", "medium", "low"];
const MODES = ["copy", "replace"];
const DEFAULTS = { thresholdMiB: 25, strongest: "medium", mode: "copy", folders: [] };
const COPY_SUFFIX = ".compressed.pdf";
const HISTORY_LIMIT = 200;
/** How long a file must stop changing before it is touched (downloads in progress). */
const SETTLE_MS = 2000;
const TOOL_NAME = "compress_pdf_if_large";

const mib = bytes => `${(bytes / MIB).toFixed(1)} MiB`;
const isPdf = name => /\.pdf$/i.test(name);
const isOwnCopy = name => name.toLowerCase().endsWith(COPY_SUFFIX);
const expandHome = p => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);
const isInside = (file, folder) => file === folder || file.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep);

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return fallback;
		throw new Error(`Cannot read ${file}: ${error.message}`);
	}
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify(value, null, "\t"));
	fs.renameSync(temporary, file);
}

/** Validate a complete settings object, returning its normalised form. */
function checkSettings(raw) {
	const { thresholdMiB, strongest, mode } = raw;
	if (typeof thresholdMiB !== "number" || !(thresholdMiB >= 1 && thresholdMiB <= 10000)) {
		throw new Error("The size limit must be between 1 and 10000 MiB.");
	}
	if (!PRESETS.includes(strongest)) throw new Error(`Unknown quality "${strongest}".`);
	if (!MODES.includes(mode)) throw new Error(`Unknown mode "${mode}".`);
	// The settings page sends folders as one ";"-separated line.
	const list = typeof raw.folders === "string" ? raw.folders.split(/[;\n]/) : raw.folders;
	if (!Array.isArray(list) || list.some(f => typeof f !== "string")) throw new Error("Folders must be a list of paths.");
	const folders = [];
	for (const entry of list.map(f => f.trim()).filter(Boolean)) {
		const folder = expandHome(entry);
		if (!path.isAbsolute(folder)) throw new Error(`"${entry}" is not an absolute path (or one starting with ~/).`);
		let real;
		try {
			real = fs.realpathSync(folder);
		} catch {
			throw new Error(`"${entry}" does not exist.`);
		}
		if (!fs.statSync(real).isDirectory()) throw new Error(`"${entry}" is not a folder.`);
		// Watching is recursive: these would sweep up every PDF the user owns.
		if (real === path.parse(real).root || real === fs.realpathSync(os.homedir())) {
			throw new Error(`"${entry}" is too broad to watch. Choose a folder inside it.`);
		}
		if (!folders.includes(real)) folders.push(real);
	}
	return { thresholdMiB, strongest, mode, folders };
}

exports.activate = ctx => {
	const settingsFile = path.join(ctx.dataDirectory, "settings.json");
	const historyFile = path.join(ctx.dataDirectory, "history.json");
	const binary =
		process.env.PDF_SHRINK_BIN || path.join(ctx.directory, "bin", process.platform === "win32" ? "pdf-shrink.exe" : "pdf-shrink");

	let settings = checkSettings({ ...DEFAULTS, ...readJson(settingsFile, {}) });
	/** Newest first. One entry per attempt; see `attempt` for the fields. */
	let history = readJson(historyFile, []);
	let current = null;
	let queue = Promise.resolve();
	const inFlight = new Map();
	const timers = new Map();
	let watchers = [];
	let watchErrors = [];

	const changed = () => {
		if (!ctx.signal.aborted) ctx.events.emit("changed");
	};

	// ── Running the compressor ───────────────────────────────────────────

	function shrink(args) {
		return new Promise((resolve, reject) => {
			const child = spawn(binary, [...args, "--json"], { stdio: ["ignore", "pipe", "pipe"], signal: ctx.signal });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", chunk => (stdout += chunk));
			child.stderr.on("data", chunk => (stderr += chunk));
			// The compressor never ran; this says nothing about the PDF.
			child.on("error", error => {
				const message = error.code === "ENOENT" ? `The pdf-shrink binary is missing (${binary}).` : error.message;
				reject(Object.assign(new Error(message), { transient: true }));
			});
			child.on("close", () => {
				let report;
				try {
					report = JSON.parse(stdout);
				} catch {
					return reject(new Error(stderr.trim() || "pdf-shrink produced no report."));
				}
				if (report.error) reject(new Error(report.error));
				else resolve(report);
			});
		});
	}

	/** Compress one over-limit file according to the current settings and record it. */
	async function attempt(source, stat) {
		const { strongest, mode } = settings;
		const limit = settings.thresholdMiB * MIB;
		const entry = { at: new Date().toISOString(), source, limit, strongest, mode, originalBytes: stat.size };
		const args = [source, "--target-size", String(limit), "--preset", strongest];
		let backup;
		try {
			if (mode === "replace") {
				// The original is kept under the plugin's data until the user removes it.
				backup = path.join(ctx.dataDirectory, "originals", `${Date.now()}-${path.basename(source)}`);
				await fsp.mkdir(path.dirname(backup), { recursive: true });
				await fsp.copyFile(source, backup);
				args.push("--in-place");
			} else {
				args.push("--output", source.slice(0, -".pdf".length) + COPY_SUFFIX);
			}
			const report = await shrink(args);
			entry.compressedBytes = report.written ? report.compressed_bytes : stat.size;
			entry.preset = report.preset;
			if (report.written) {
				entry.output = report.output;
				entry.status = report.target_met ? "compressed" : "over";
				if (backup) entry.backup = backup;
			} else {
				entry.status = "unchanged";
			}
		} catch (error) {
			entry.status = "failed";
			entry.message = error.message;
			entry.transient = error.transient;
		}
		if (backup && !entry.backup) await fsp.rm(backup, { force: true });
		if (entry.transient) return entry;
		// Remember the file as it is now, so the same file is not attempted twice.
		const now = await fsp.stat(source).catch(() => stat);
		entry.sourceBytes = now.size;
		entry.sourceMtime = now.mtimeMs;
		if (!ctx.signal.aborted) {
			history = [entry, ...history.filter(h => h.source !== source)].slice(0, HISTORY_LIMIT);
			writeJson(historyFile, history);
		}
		return entry;
	}

	/**
	 * Make sure `file` is within the size limit, compressing it if it is not.
	 * Resolves to `{ status, path, bytes, ... }` where `path` is the file to use:
	 *   small       already within the limit, untouched
	 *   compressed  now within the limit
	 *   over        smaller, but the limit could not be reached at the allowed quality
	 *   unchanged   could not be made smaller
	 *   failed      the compressor reported an error (`message`)
	 */
	async function fit(file) {
		const source = await fsp.realpath(file);
		const stat = await fsp.stat(source);
		if (!stat.isFile() || !isPdf(source)) throw new Error(`${file} is not a PDF file.`);
		const limit = settings.thresholdMiB * MIB;
		if (stat.size <= limit) return { status: "small", path: source, bytes: stat.size };
		if (isOwnCopy(source)) return { status: "over", path: source, bytes: stat.size, originalBytes: stat.size };

		const describe = entry => ({
			status: entry.status,
			path: entry.output ?? source,
			bytes: entry.compressedBytes ?? stat.size,
			originalBytes: entry.originalBytes,
			preset: entry.preset,
			message: entry.message,
		});
		const before = history.find(
			h =>
				h.source === source &&
				h.sourceBytes === stat.size &&
				h.sourceMtime === stat.mtimeMs &&
				h.limit === limit &&
				h.strongest === settings.strongest &&
				h.mode === settings.mode &&
				(!h.output || fs.existsSync(h.output)),
		);
		if (before) return describe(before);

		// One compression at a time: pdf-shrink already uses every core.
		if (!inFlight.has(source)) {
			const run = queue.then(async () => {
				current = source;
				changed();
				try {
					return await attempt(source, stat);
				} finally {
					current = null;
					inFlight.delete(source);
					changed();
				}
			});
			queue = run.catch(() => {});
			inFlight.set(source, run);
		}
		return describe(await inFlight.get(source));
	}

	// ── Watched folders ──────────────────────────────────────────────────

	const isCandidate = name => isPdf(name) && !isOwnCopy(name);

	/** A PDF appeared or changed: once it has stopped changing, fit it. */
	function arrived(file, earlier) {
		clearTimeout(timers.get(file));
		timers.set(
			file,
			setTimeout(async () => {
				timers.delete(file);
				const stat = await fsp.stat(file).catch(() => null);
				if (ctx.signal.aborted || !stat?.isFile() || stat.size <= settings.thresholdMiB * MIB) return;
				if (earlier?.size !== stat.size || earlier?.mtimeMs !== stat.mtimeMs) return arrived(file, stat);
				fit(file).catch(() => {});
			}, SETTLE_MS),
		);
	}

	async function scan(folder, depth = 0) {
		let found = 0;
		const entries = await fsp.readdir(folder, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (ctx.signal.aborted) break;
			const full = path.join(folder, entry.name);
			if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && depth < 12) {
				found += await scan(full, depth + 1);
			} else if (entry.isFile() && isCandidate(entry.name)) {
				const stat = await fsp.stat(full).catch(() => null);
				if (stat && stat.size > settings.thresholdMiB * MIB) {
					arrived(full);
					found++;
				}
			}
		}
		return found;
	}

	const scanAll = async () => (await Promise.all(settings.folders.map(folder => scan(folder)))).reduce((a, b) => a + b, 0);

	function watch() {
		for (const watcher of watchers) watcher.close();
		watchers = [];
		watchErrors = [];
		for (const folder of settings.folders) {
			try {
				const watcher = fs.watch(folder, { recursive: true }, (_event, name) => {
					if (name && isCandidate(name)) arrived(path.join(folder, name));
				});
				watcher.on("error", error => {
					watchErrors.push(`${folder}: ${error.message}`);
					changed();
				});
				watchers.push(watcher);
			} catch (error) {
				watchErrors.push(`${folder}: ${error.message}`);
			}
		}
		scanAll().catch(() => {});
	}

	// ── The teacher's hook ───────────────────────────────────────────────

	/** Resolve a path the way the host's own file tools do, honouring File access. */
	async function learnerPath(given) {
		const real = await fsp.realpath(path.resolve(os.homedir(), expandHome(given)));
		const access = readJson(path.join(ctx.learning.directory, "settings.json"), {}).fileAccess;
		if (access?.restricted) {
			const allowed = (Array.isArray(access.folders) ? access.folders : []).flatMap(folder => {
				try {
					return [fs.realpathSync(expandHome(folder))];
				} catch {
					return [];
				}
			});
			if (!allowed.some(folder => isInside(real, folder))) {
				throw new Error(`${given} is outside the folders allowed in File access settings.`);
			}
		}
		return real;
	}

	async function toolReply(given) {
		let result;
		try {
			result = await fit(await learnerPath(given));
		} catch (error) {
			const why = error.code === "ENOENT" ? `${given} does not exist.` : error.message;
			return { text: `Could not check the PDF: ${why} Use the path the learner gave.`, details: { status: "failed", message: why } };
		}
		const limit = `${settings.thresholdMiB} MiB`;
		const shrunk = `${mib(result.originalBytes ?? result.bytes)} to ${mib(result.bytes)}`;
		const text = {
			small: `The PDF is ${mib(result.bytes)}, within the ${limit} limit. Use this path: ${result.path}`,
			compressed: `The PDF was over the ${limit} limit and has been compressed from ${shrunk}. Use this path: ${result.path}`,
			over: `The PDF was compressed from ${shrunk}, which is still over the ${limit} limit; it cannot be made smaller at the allowed quality. Use this path: ${result.path}`,
			unchanged: `The PDF is ${mib(result.bytes)}, over the ${limit} limit, and could not be made smaller. Use this path: ${result.path}`,
			failed: `The PDF is over the ${limit} limit but compressing it failed (${result.message}). Use this path: ${result.path}`,
		}[result.status];
		return { text, details: result };
	}

	const agents = ["teacher", "practice", "prober"];
	ctx.registerInstructions({
		agents,
		text:
			`Large PDFs: before you dispatch a \`pdf\` job for a local file, call \`${TOOL_NAME}\` with the learner's path, ` +
			"then give `pdf` the path it returns. It leaves PDFs within the size limit alone and compresses bigger ones. " +
			"Do this silently; mention it only if it reports a problem.",
	});
	ctx.registerTools({
		agents,
		create: () => [
			{
				name: TOOL_NAME,
				label: "Compress PDF if large",
				description:
					"Check a local PDF against the size limit and compress it if it is over. Returns the path to read: " +
					"the original when it is small enough, otherwise a compressed version. Call before a `pdf` job.",
				parameters: {
					type: "object",
					properties: { path: { type: "string", description: "Path to the learner's PDF, exactly as they gave it." } },
					required: ["path"],
					additionalProperties: false,
				},
				execute: async (_toolCallId, input, signal) => {
					if (signal?.aborted || ctx.signal.aborted) throw new Error("Cancelled");
					const { text, details } = await toolReply(String(input.path));
					return { content: [{ type: "text", text }], details };
				},
			},
		],
	});

	// ── Settings page bridge ─────────────────────────────────────────────

	const tilde = folder => (isInside(folder, os.homedir()) ? `~${folder.slice(os.homedir().length)}` : folder);
	const state = () => ({
		settings: { ...settings, folders: settings.folders.map(tilde) },
		history: history.slice(0, 30),
		current,
		waiting: Math.max(0, inFlight.size - (current ? 1 : 0)) + timers.size,
		problems: [...watchErrors, ...(fs.existsSync(binary) ? [] : [`The pdf-shrink binary is missing (${binary}). Rebuild the plugin.`])],
	});

	ctx.handle("state", state);
	ctx.handle("save-settings", patch => {
		if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Expected a settings object.");
		const next = checkSettings({ ...settings, ...patch });
		writeJson(settingsFile, next);
		settings = next;
		watch();
		changed();
		return state();
	});
	ctx.handle("scan", async () => ({ found: await scanAll() }));

	ctx.cleanup(() => {
		for (const watcher of watchers) watcher.close();
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
	});
	watch();
};
