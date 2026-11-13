# Image test fixtures

`page-1.png`, `page-2.png`, and `page-3.png` are generated 600 × 900 RGB PNGs. They contain only flat colors, rectangular panels, and an empty speech area. Node's standard `zlib` module encodes them, with a handwritten PNG CRC routine. They have no third-party artwork or font dependencies and exercise the same image probing, matching, decoding, thumbnail, canvas, and checksum paths as imported pages.
