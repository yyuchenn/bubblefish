import type { ProjectDocument } from '../generated/core';
import type { JsonValue, PluginEntityChange } from '../generated/plugins';
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function documentChanges(
  before: ProjectDocument,
  after: ProjectDocument,
): PluginEntityChange[] {
  const changes: PluginEntityChange[] = [];
  const add = (kind: string, imageId?: string, markerId?: string, old?: unknown, value?: unknown) =>
    changes.push({
      kind,
      ...(imageId ? { imageId } : {}),
      ...(markerId ? { markerId } : {}),
      ...(old === undefined ? {} : { before: json(old) }),
      ...(value === undefined ? {} : { after: json(value) }),
    });
  const oldImages = new Map(before.images.map((image) => [image.id, image]));
  const newImages = new Map(after.images.map((image) => [image.id, image]));
  const removedMarker = (
    imageId: string,
    marker: ProjectDocument['images'][number]['markers'][number],
  ) => {
    add('marker.removed', imageId, marker.id, marker);
    add('translation.changed', imageId, marker.id, marker.translation);
    if (marker.bunnyCache !== undefined)
      add('assistance.changed', imageId, marker.id, marker.bunnyCache);
  };
  for (const image of before.images)
    if (!newImages.has(image.id)) {
      add('image.removed', image.id, undefined, image);
      image.markers.forEach((marker) => removedMarker(image.id, marker));
    }
  for (const image of after.images) {
    const old = oldImages.get(image.id);
    if (!old) add('image.added', image.id, undefined, undefined, image);
    else {
      const { markers: _a, ...oldMeta } = old,
        { markers: _b, ...newMeta } = image;
      if (!equal(oldMeta, newMeta)) add('image.updated', image.id, undefined, oldMeta, newMeta);
    }
    const oldMarkers = new Map((old?.markers ?? []).map((marker) => [marker.id, marker]));
    const newMarkers = new Map(image.markers.map((marker) => [marker.id, marker]));
    for (const marker of old?.markers ?? [])
      if (!newMarkers.has(marker.id)) removedMarker(image.id, marker);
    for (const marker of image.markers) {
      const previous = oldMarkers.get(marker.id);
      if (!previous) add('marker.added', image.id, marker.id, undefined, marker);
      else if (!equal(previous, marker))
        add('marker.updated', image.id, marker.id, previous, marker);
      if (!equal(previous?.translation, marker.translation))
        add('translation.changed', image.id, marker.id, previous?.translation, marker.translation);
      if (!equal(previous?.bunnyCache, marker.bunnyCache))
        add('assistance.changed', image.id, marker.id, previous?.bunnyCache, marker.bunnyCache);
    }
    if (
      old &&
      !equal(
        old.markers.map((marker) => marker.id),
        image.markers.map((marker) => marker.id),
      )
    )
      add(
        'markers.reordered',
        image.id,
        undefined,
        old.markers.map((marker) => marker.id),
        image.markers.map((marker) => marker.id),
      );
  }
  if (
    !equal(
      before.images.map((image) => image.id),
      after.images.map((image) => image.id),
    )
  )
    add(
      'images.reordered',
      undefined,
      undefined,
      before.images.map((image) => image.id),
      after.images.map((image) => image.id),
    );
  if (
    before.name !== after.name ||
    before.sourceLanguage !== after.sourceLanguage ||
    before.targetLanguage !== after.targetLanguage
  )
    add(
      'project.updated',
      undefined,
      undefined,
      {
        name: before.name,
        sourceLanguage: before.sourceLanguage,
        targetLanguage: before.targetLanguage,
      },
      {
        name: after.name,
        sourceLanguage: after.sourceLanguage,
        targetLanguage: after.targetLanguage,
      },
    );
  return changes;
}
