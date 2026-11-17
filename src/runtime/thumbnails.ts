import { platform, type PickedFile } from './platform';

// Reserve at most two full-resolution decodes, including previews in the new-project dialog.
let active = 0;
const waiting: Array<() => void> = [];
async function slot<T>(operation: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => {
    if (active < 2) {
      active++;
      resolve();
    } else waiting.push(resolve);
  });
  try {
    return await operation();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
export function createThumbnail(
  picked: PickedFile,
  cancelled: () => boolean = () => false,
): Promise<string | undefined> {
  return slot(async () => {
    if (cancelled()) return;
    const file = picked.file ?? (await platform.readFile(picked.path!)).file;
    if (cancelled()) return;
    const url = URL.createObjectURL(file),
      image = new Image();
    try {
      image.src = url;
      await image.decode();
      if (cancelled()) return;
      const canvas = document.createElement('canvas'),
        scale = Math.min(1, 160 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
      const result = canvas.toDataURL('image/jpeg', 0.7);
      canvas.width = canvas.height = 1;
      return result;
    } finally {
      image.src = '';
      URL.revokeObjectURL(url);
    }
  });
}
