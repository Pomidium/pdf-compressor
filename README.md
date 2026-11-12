# PDF Compressor for LearnHarness

Keeps PDFs under a size limit without you thinking about it.

- **When the teacher reads a PDF.** The teacher, prober and practice agents get a
  `compress_pdf_if_large` tool and are told to call it before dispatching a `pdf`
  job. A PDF within the limit is passed through untouched; a bigger one is
  compressed and the agent reads the compressed file instead. Paths follow the
  app's File access settings.
- **When a PDF lands in a watched folder.** Optional: list folders in the plugin's
  settings and any PDF over the limit that appears in them (or is already there)
  is compressed once it has finished downloading.

The gentlest compression that gets under the limit is used: lossless first, then
progressively lower image resolution, never below the quality you allow. A file
that has already been tried is not tried again until it or the settings change.

## Settings

Settings → PDF Compressor.

| Setting | Default | |
| --- | --- | --- |
| Size limit | 25 MiB | PDFs larger than this are compressed. 25 MiB is also the host's own document cap. |
| Lowest quality allowed | Medium (150 dpi) | `Lossless only` never touches image pixels. |
| Compressed file | Copy | `book.pdf` → `book.compressed.pdf` beside it. Or replace the original, keeping it in the plugin's `data/originals/`. |
| Watched folders | none | `;`-separated. Watched recursively. |

The same page lists what has been compressed.

## Build and install

The compression itself is [`pdf-shrink`](https://github.com/Pomidium/pdf-shrink), a separate Rust library
and CLI. The build compiles it and bundles the binary into `dist/bin/`, so it
needs `cargo` and the crate at `../pdf-shrink` (or `PDF_SHRINK_DIR=/path/to/crate`).

```sh
npm run install:local -- "<plugins directory from Settings → Community plugins>"
```

Then refresh Community plugins and enable **PDF Compressor**; restart LearnHarness
after updating an already-loaded version. The bundled binary is built for the
machine that ran the build.

`npm test` builds, then drives the backend with real PDFs and the real binary.

## Layout

```text
src/backend.cjs   when to compress, where results go, folder watching, the agent tool
src/main.js       settings page
scripts/build.mjs assembles dist/ (plugin files + pdf-shrink binary)
```
