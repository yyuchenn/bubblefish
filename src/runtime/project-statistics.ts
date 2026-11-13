import type { ProjectDocument } from '../generated/core';

export interface ProjectStatistics {
  totalMarkers: number;
  nonEmptyMarkers: number;
  totalCharacters: number;
}

/** Count human translations by Unicode code point, excluding JavaScript whitespace. */
export function projectStatistics(project: ProjectDocument): ProjectStatistics {
  let totalMarkers = 0;
  let nonEmptyMarkers = 0;
  let totalCharacters = 0;
  for (const image of project.images) {
    totalMarkers += image.markers.length;
    for (const marker of image.markers) {
      const text = marker.translation.runs.map((run) => run.text).join('');
      let characters = 0;
      for (const character of text) {
        if (character.trim().length > 0) characters++;
      }
      if (characters > 0) nonEmptyMarkers++;
      totalCharacters += characters;
    }
  }
  return { totalMarkers, nonEmptyMarkers, totalCharacters };
}
