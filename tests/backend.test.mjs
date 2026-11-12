// Drives the built backend (dist/, so run `npm run build` first) through a
// stand-in for the host context, with real PDFs and the real compressor.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { activate } = createRequire(import.meta.url)(path.join(dist, "backend.cjs"));
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pdf-compressor-")));
const controllers = [];
after(() => {
	for (const controller of controllers) controller.abort();
	fs.rmSync(scratch, { recursive: true, force: true });
});

/** A one-page PDF holding an uncompressed 700x700 photo-like image: about 1.4 MiB. */
function samplePdf() {
	const pixels = Buffer.alloc(700 * 700 * 3);
	let noise = 1;
	for (let i = 0; i < pixels.length; i++) {
		noise = (noise * 1664525 + 1013904223) >>> 0;
		pixels[i] = (((i / 3) % 700) / 3 + (noise >>> 27)) & 0xff;
	}
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im 5 0 R >> >> >>",
		"<< /Length 31 >>\nstream\nq 288 0 0 288 36 400 cm /Im Do Q\nendstream",
		Buffer.concat([
			Buffer.from(`<< /Type /XObject /Subtype /Image /Width 700 /Height 700 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`),
			pixels,
			Buffer.from("\nendstream"),
		]),
	];
	const parts = [Buffer.from("%PDF-1.4\n")];
	const offsets = [];
	let length = parts[0].length;
	objects.forEach((body, index) => {
		offsets.push(length);
		const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(body), Buffer.from("\nendobj\n")]);
		parts.push(part);
		length += part.length;
	});
	const xref = offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
	parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${xref}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
	return Buffer.concat(parts);
}
const SAMPLE = samplePdf();

/** Activate the backend in its own data directory; returns handles onto it. */
function plugin(settings, hostSettings = {}) {
	const home = fs.mkdtempSync(path.join(scratch, "run-"));
	const dataDirectory = path.join(home, "data");
	const learning = path.join(home, "learning");
	fs.mkdirSync(dataDirectory);
	fs.mkdirSync(learning);
	fs.writeFileSync(path.join(dataDirectory, "settings.json"), JSON.stringify(settings));
	fs.writeFileSync(path.join(learning, "settings.json"), JSON.stringify(hostSettings));
	const controller = new AbortController();
	controllers.push(controller);
	const handlers = {};
	let tools;
	activate({
		directory: dist,
		dataDirectory,
		signal: controller.signal,
		learning: { directory: learning },
		events: { emit() {} },
		cleanup: dispose => controller.signal.addEventListener("abort", dispose),
		registerInstructions() {},
		registerTools: contribution => (tools = contribution.create({ chatId: "c", agent: "teacher" })),
		handle: (name, handler) => (handlers[name] = handler),
	});
	const fit = async file => (await tools[0].execute("call", { path: file }, controller.signal)).details;
	const put = name => {
		const file = path.join(home, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, SAMPLE);
		return file;
	};
	return { home, dataDirectory, handlers, fit, put };
}

test("a PDF within the limit is left alone", async () => {
	const { fit, put, handlers } = plugin({ thresholdMiB: 25 });
	const file = put("small.pdf");
	assert.deepEqual(await fit(file), { status: "small", path: file, bytes: SAMPLE.length });
	assert.equal(handlers.state().history.length, 0);
});

test("a PDF over the limit gets a compressed copy, made once", async () => {
	const { fit, put, handlers } = plugin({ thresholdMiB: 1 });
	const file = put("big.pdf");
	const result = await fit(file);
	assert.equal(result.status, "compressed");
	assert.equal(result.path, path.join(path.dirname(file), "big.compressed.pdf"));
	assert.ok(fs.statSync(result.path).size <= 1024 * 1024);
	assert.ok(fs.readFileSync(file).equals(SAMPLE), "the original is untouched");

	const made = fs.statSync(result.path).mtimeMs;
	assert.deepEqual(await fit(file), result);
	assert.equal(fs.statSync(result.path).mtimeMs, made);
	assert.equal(handlers.state().history.length, 1);
});

test("replace mode swaps the original and keeps a backup", async () => {
	const { fit, put, dataDirectory } = plugin({ thresholdMiB: 1, mode: "replace" });
	const file = put("book.pdf");
	const result = await fit(file);
	assert.equal(result.status, "compressed");
	assert.equal(result.path, file);
	assert.ok(fs.statSync(file).size <= 1024 * 1024);
	const backups = fs.readdirSync(path.join(dataDirectory, "originals"));
	assert.equal(backups.length, 1);
	assert.ok(fs.readFileSync(path.join(dataDirectory, "originals", backups[0])).equals(SAMPLE));
	assert.equal((await fit(file)).status, "small");
});

test("lossless-only reports a file it cannot get under the limit", async () => {
	const { fit, put } = plugin({ thresholdMiB: 1, strongest: "lossless" });
	const result = await fit(put("noisy.pdf"));
	assert.equal(result.status, "over");
	assert.ok(result.bytes > 1024 * 1024 && result.bytes < SAMPLE.length);
});

test("a broken PDF is recorded as failed; a missing one is only reported", async () => {
	const { fit, home, handlers } = plugin({ thresholdMiB: 1 });
	const file = path.join(home, "fake.pdf");
	fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, "x"));
	const result = await fit(file);
	assert.equal(result.status, "failed");
	assert.match(result.message, /not a readable PDF/);
	assert.equal((await fit(path.join(home, "absent.pdf"))).status, "failed");
	assert.equal(handlers.state().history.length, 1);
});

test("File access restrictions are honoured", async () => {
	const allowed = fs.mkdtempSync(path.join(scratch, "allowed-"));
	const { fit, put } = plugin({ thresholdMiB: 1 }, { fileAccess: { restricted: true, folders: [allowed] } });
	const outside = put("outside.pdf");
	const refused = await fit(outside);
	assert.match(refused.message, /outside the folders allowed/);
	assert.ok(!fs.existsSync(outside.replace(/\.pdf$/, ".compressed.pdf")));

	fs.writeFileSync(path.join(allowed, "inside.pdf"), SAMPLE);
	assert.equal((await fit(path.join(allowed, "inside.pdf"))).status, "compressed");
});

test("a PDF arriving in a watched folder is compressed", async () => {
	const { home, put, handlers } = plugin({ thresholdMiB: 1 });
	const folder = path.join(home, "inbox");
	fs.mkdirSync(folder);
	put("inbox/already-here.pdf");
	handlers["save-settings"]({ folders: folder });
	await sleep(500);
	put("inbox/nested/arrives-later.pdf");
	for (const name of ["already-here", "nested/arrives-later"]) {
		const copy = path.join(folder, `${name}.compressed.pdf`);
		for (let waited = 0; !fs.existsSync(copy) && waited < 15000; waited += 250) await sleep(250);
		assert.ok(fs.existsSync(copy), `${name} was compressed`);
	}
	// Its own output must not be picked up and compressed again.
	await sleep(5000);
	assert.deepEqual(fs.readdirSync(folder).sort(), ["already-here.compressed.pdf", "already-here.pdf", "nested"]);
	assert.equal(handlers.state().history.length, 2);
});

test("settings are validated before they are saved", () => {
	const { handlers, dataDirectory } = plugin({});
	assert.throws(() => handlers["save-settings"]({ folders: "/no/such/folder" }), /does not exist/);
	assert.throws(() => handlers["save-settings"]({ folders: "~" }), /too broad/);
	assert.throws(() => handlers["save-settings"]({ thresholdMiB: 0 }), /between 1 and 10000/);
	assert.throws(() => handlers["save-settings"]({ strongest: "tiny" }), /Unknown quality/);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDirectory, "settings.json"))), {});
	assert.equal(handlers["save-settings"]({ thresholdMiB: 40 }).settings.thresholdMiB, 40);
});
