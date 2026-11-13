# Legacy file boundary

This crate contains a fresh implementation of the BF 1.0 and LabelPlus protocols. It has no filesystem or runtime dependencies. `import_project` builds a complete document before returning it; images have stable IDs and unresolved dimensions (`0 × 0`). Callers associate the external image assets and install the resulting document only after confirmation.

`Format::Bf` serializes as `bf`; `Format::Labelplus` serializes as `labelplus`. Import results contain `document`, `warnings`, and `forceSaveAs`. Unknown archive entries, unknown JSON fields, or unknown LabelPlus styles set `forceSaveAs` so an adapter cannot overwrite their source accidentally. Ambiguous rich text retains its original string until its semantic content changes.

BF contains `metadata.json`, `styles.json`, `images.json`, `markers.json`, and optionally `bunny_cache.json` inside gzip/tar. Coordinates are converted between BF percentages and normalized core coordinates. Image dimensions, runtime IDs, and binary image resources do not belong to this legacy format. Bunny payloads belong to the stable marker object and receive new positional indexes during export. Unknown Bunny payload properties survive round trips.

Exports are reproducible across native and WASM: tar mtimes and the metadata `exportDate` use the Unix epoch, rather than making the core depend on a platform clock. `exportDate` does not affect project semantics.

The parser never extracts files. Compressed input and expanded BF archives are each limited to 64 MiB. Missing required files, duplicate entries or style IDs, nonregular tar entries, unsafe paths, invalid references, invalid coordinates, and malformed JSON fail the import.

LabelPlus accepts UTF-8 with optional BOM and LF or CRLF. It emits UTF-8 CRLF, continuous per-page numbering, and all image sections including empty pages. Rectangles become their upper-edge midpoint. Header comments carry source/target languages, but LabelPlus cannot carry the project name, image checksums, or Bunny cache. Applications must explain these losses when users select LabelPlus export. Duplicate filenames and reserved separators inside translations are rejected because old readers cannot preserve them.

Inline text uses `[content](\加粗\斜体\划掉\重点)`. Unknown formatting remains verbatim and produces an import warning. Export checks the decoded result against the requested rich text. Formatted `]` characters and plain text that becomes a legacy formatting delimiter produce a located `unrepresentableText` error; callers should surface this error instead of discarding formatting.

The fixtures under `tests/fixtures/` are handwritten protocol examples, not copied implementation or user data. `cargo test -p bubblefish-formats` covers semantic round trips, Unicode and multiline text, extensions, cache reordering, structural failures, unsafe delimiters, and the decompression bound.
