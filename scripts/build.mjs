// Assemble dist/: the plugin's own files plus the pdf-shrink binary, built from
// the Rust crate at $PDF_SHRINK_DIR (default: ../pdf-shrink).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const crate = path.resolve(root, process.env.PDF_SHRINK_DIR ?? "../pdf-shrink");
const binary = process.platform === "win32" ? "pdf-shrink.exe" : "pdf-shrink";

// dist/ is generated and may be deleted; anything else must never be.
if (fs.lstatSync(dist, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error(`Refusing symlinked dist: ${dist}`);
if (fs.lstatSync(path.join(dist, "data"), { throwIfNoEntry: false })) throw Error(`Refusing misplaced dist/data: ${dist}`);

execFileSync("cargo", ["build", "--release", "--manifest-path", path.join(crate, "Cargo.toml")], { stdio: "inherit" });

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "bin"), { recursive: true });
for (const file of fs.readdirSync(path.join(root, "src"))) fs.copyFileSync(path.join(root, "src", file), path.join(dist, file));
fs.copyFileSync(path.join(crate, "target", "release", binary), path.join(dist, "bin", binary));
fs.chmodSync(path.join(dist, "bin", binary), 0o755);
console.log(`Built ${dist}`);
