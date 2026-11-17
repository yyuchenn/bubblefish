/// <reference lib="webworker" />
import { Zip, ZipPassThrough } from 'fflate';
const zip = new Zip((error, data, final) => {
  if (error) self.postMessage({ error: error.message });
  else {
    const bytes = new Uint8Array(data).buffer;
    self.postMessage({ bytes, final }, { transfer: [bytes] });
  }
});
self.onmessage = ({
  data,
}: MessageEvent<{ name?: string; bytes?: ArrayBuffer; end?: boolean }>) => {
  try {
    if (data.end) zip.end();
    else if (data.name && data.bytes) {
      const file = new ZipPassThrough(data.name);
      zip.add(file);
      file.push(new Uint8Array(data.bytes), true);
    }
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
