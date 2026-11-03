import type { Command, ImageDocument, RichText } from '../generated/core';
import type { PluginOperation } from '../generated/plugins';

export const isMutation = (command: Command) =>
  ![
    'createProject',
    'closeProject',
    'undo',
    'redo',
    'guardedUndo',
    'guardedRedo',
    'endGroup',
    'markSaved',
  ].includes(command.type);
export const isHistory = (command: Command) =>
  ['undo', 'redo', 'guardedUndo', 'guardedRedo'].includes(command.type);
export function stagedHandles(operations: PluginOperation[]): string[] {
  return [
    ...new Set(
      operations.flatMap((operation) =>
        'stagedResource' in operation && operation.stagedResource ? [operation.stagedResource] : [],
      ),
    ),
  ];
}
export function commandsToOperations(
  commands: Command[],
  stage: (image: ImageDocument) => string,
): PluginOperation[] {
  return commands.flatMap((command): PluginOperation[] => {
    switch (command.type) {
      case 'batch':
        return commandsToOperations(command.commands, stage);
      case 'updateProject':
        return [{ ...command, type: 'project.update' }];
      case 'addImages':
        return command.images.flatMap((image) => [
          {
            type: 'image.create',
            id: image.id,
            stagedResource: stage(image),
            filename: image.filename,
          },
          ...image.markers.map((marker) => ({
            type: 'marker.create' as const,
            imageId: image.id,
            marker,
          })),
        ]);
      case 'updateImage': {
        if (command.assetId) throw new Error('资源替换请使用图片事务');
        return [
          {
            type: 'image.update',
            imageId: command.imageId,
            ...(command.filename === undefined ? {} : { filename: command.filename }),
          },
        ];
      }
      case 'removeImage':
        return [{ type: 'image.remove', imageId: command.imageId }];
      case 'reorderImages':
        return [{ type: 'image.reorder', imageIds: command.imageIds }];
      case 'addMarker':
        return [{ type: 'marker.create', imageId: command.imageId, marker: command.marker }];
      case 'removeMarker':
        return [{ type: 'marker.remove', imageId: command.imageId, markerId: command.markerId }];
      case 'updateMarker':
        return [{ ...command, type: 'marker.update' }];
      case 'reorderMarkers':
        return [{ type: 'marker.reorder', imageId: command.imageId, markerIds: command.markerIds }];
      case 'updateAssistance':
        return command.updates.map(({ imageId, markerId, expected, ...patch }) => ({
          type: 'assistance.update',
          imageId,
          markerId,
          patch,
          ...(expected ? { expected } : {}),
        }));
      default:
        throw new Error('此操作不能用于文档事务');
    }
  });
}
export function operationsToCommands(
  operations: PluginOperation[],
  resolve: (handle: string) => ImageDocument,
): Command[] {
  if (!Array.isArray(operations) || operations.length > 10000)
    throw new Error('事务操作必须为数组，最多 10000 项');
  return operations.map((operation): Command => {
    if (!operation || typeof operation !== 'object') throw new Error('事务操作无效');
    switch (operation.type) {
      case 'project.update':
        return {
          type: 'updateProject',
          name: operation.name,
          sourceLanguage: operation.sourceLanguage,
          targetLanguage: operation.targetLanguage,
        };
      case 'image.create': {
        const image = resolve(operation.stagedResource);
        return {
          type: 'addImages',
          images: [
            {
              ...image,
              id: operation.id,
              filename: operation.filename ?? image.filename,
              markers: [],
            },
          ],
        };
      }
      case 'image.update': {
        const image = operation.stagedResource ? resolve(operation.stagedResource) : undefined;
        return {
          type: 'updateImage',
          imageId: operation.imageId,
          ...(operation.filename === undefined ? {} : { filename: operation.filename }),
          ...(image
            ? {
                assetId: image.assetId,
                width: image.width,
                height: image.height,
                checksum: image.checksum,
              }
            : {}),
        };
      }
      case 'image.remove':
        return { type: 'removeImage', imageId: operation.imageId };
      case 'image.reorder':
        return { type: 'reorderImages', imageIds: operation.imageIds };
      case 'marker.create':
        return { type: 'addMarker', imageId: operation.imageId, marker: operation.marker };
      case 'marker.update':
        return {
          type: 'updateMarker',
          imageId: operation.imageId,
          markerId: operation.markerId,
          geometry: operation.geometry,
          translation: operation.translation,
          style: operation.style,
        };
      case 'marker.remove':
        return { type: 'removeMarker', imageId: operation.imageId, markerId: operation.markerId };
      case 'marker.reorder':
        return {
          type: 'reorderMarkers',
          imageId: operation.imageId,
          markerIds: operation.markerIds,
        };
      case 'translation.set':
        return {
          type: 'updateMarker',
          imageId: operation.imageId,
          markerId: operation.markerId,
          translation: richText(operation.value),
        };
      case 'translation.clear':
        return {
          type: 'updateMarker',
          imageId: operation.imageId,
          markerId: operation.markerId,
          translation: { runs: [] },
        };
      case 'assistance.update':
        return {
          type: 'updateAssistance',
          updates: [
            {
              imageId: operation.imageId,
              markerId: operation.markerId,
              ...operation.patch,
              expected: operation.expected,
            },
          ],
        };
      case 'assistance.clear':
        return {
          type: 'updateAssistance',
          updates: [
            {
              imageId: operation.imageId,
              markerId: operation.markerId,
              originalText: null,
              machineTranslation: null,
              lastOcrModel: null,
              lastTranslationService: null,
            },
          ],
        };
      default:
        throw new Error('不支持的事务操作');
    }
  });
}
export function richText(value: unknown): RichText {
  if (typeof value === 'string') return { runs: value ? [{ text: value, marks: [] }] : [] };
  if (!value || typeof value !== 'object' || !('runs' in value) || !Array.isArray(value.runs))
    throw new Error('译文必须是字符串或 RichText');
  return structuredClone(value) as RichText;
}
