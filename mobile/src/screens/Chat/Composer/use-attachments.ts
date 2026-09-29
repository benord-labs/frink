import { requireOptionalNativeModule } from 'expo';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { MOBILE_MAX_ATTACHMENTS } from '@frink/shared/types/remote/mobile';
import { uploadAttachment } from '../../../lib/api';
import { useConnection } from '../../../lib/connection';

export type ComposerAttachment = {
  key: string;
  name: string;
  kind: 'image' | 'file';
  status: 'uploading' | 'ready' | 'failed';
  /** Set once the computer has stored it. */
  id?: string;
  error?: string;
  source: Picked;
};

type Picked = { uri: string; name: string; mimeType?: string | null; kind: 'image' | 'file' };

// Formats Claude accepts as-is. Anything else (HEIC, oversized) is re-encoded first.
const PASSTHROUGH_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** The computer's image cap; a larger photo is resized rather than refused. */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const LONG_EDGE = 2048;

/** The pickers are native: an older build can still load this JS, so they load lazily and
 *  attaching is offered only when the installed build has them. */
export const attachmentsSupported =
  Platform.OS === 'web' ||
  ['ExponentImagePicker', 'ExpoDocumentPicker', 'ExpoImageManipulator'].every(
    (name) => requireOptionalNativeModule(name) !== null,
  );

let sequence = 0;
const nextKey = () => `attachment-${Date.now()}-${sequence++}`;

type ImageAsset = {
  uri: string;
  width?: number;
  height?: number;
  mimeType?: string | null;
  fileSize?: number | null;
  name: string;
};

function fitsAsIs({ mimeType, fileSize }: ImageAsset): boolean {
  return !!mimeType && PASSTHROUGH_IMAGE.has(mimeType) && (fileSize ?? Infinity) <= IMAGE_MAX_BYTES;
}

/** The resize that caps the long edge, or null when the photo is already small enough. */
function longEdgeResize({ width = 0, height = 0 }: ImageAsset) {
  if (Math.max(width, height) <= LONG_EDGE) return null;
  return width >= height ? { width: LONG_EDGE } : { height: LONG_EDGE };
}

/** Photos that already fit go up untouched; the rest become a 2048px JPEG. Never ask the picker
 *  for base64 — iOS re-encodes full-resolution photos and stalls the composer. */
async function prepareImage(asset: ImageAsset): Promise<Picked> {
  if (fitsAsIs(asset)) {
    return { uri: asset.uri, name: asset.name, mimeType: asset.mimeType, kind: 'image' };
  }
  const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
  const context = ImageManipulator.manipulate(asset.uri);
  const resize = longEdgeResize(asset);
  if (resize) context.resize(resize);
  const saved = await (
    await context.renderAsync()
  ).saveAsync({
    compress: 0.85,
    format: SaveFormat.JPEG,
  });
  const name = `${asset.name.replace(/\.[^.]+$/, '')}.jpg`;
  return { uri: saved.uri, name, mimeType: 'image/jpeg', kind: 'image' };
}

/** Picked, prepared and uploaded attachments for one conversation's composer. */
export function useComposerAttachments(target: { chatId: string; subChatId: string } | null) {
  const { connection } = useConnection();
  const [items, setItems] = useState<ComposerAttachment[]>([]);
  const targetKey = target ? `${target.chatId}:${target.subChatId}` : '';
  const live = useRef(new Map<string, AbortController>());
  const targetRef = useRef(target);
  targetRef.current = target;

  // Uploads belong to one conversation; switching drops them (the computer expires unsent ones).
  useEffect(() => {
    const uploads = live.current;
    setItems([]);
    return () => {
      for (const controller of uploads.values()) controller.abort();
      uploads.clear();
    };
  }, [targetKey]);

  const patch = useCallback((key: string, next: Partial<ComposerAttachment>) => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...next } : item)));
  }, []);

  const upload = useCallback(
    // Reason: Upload, cancellation and failure share one attachment's lifecycle.
    // fallow-ignore-next-line complexity
    async (key: string, source: Picked) => {
      const target = targetRef.current;
      if (!connection || !target) return;
      const controller = new AbortController();
      live.current.set(key, controller);
      patch(key, { status: 'uploading', error: undefined });
      try {
        const stored = await uploadAttachment(connection, target, source, controller.signal);
        if (!controller.signal.aborted)
          patch(key, { status: 'ready', id: stored.id, kind: stored.kind });
      } catch (error) {
        if (!controller.signal.aborted)
          patch(key, {
            status: 'failed',
            error: error instanceof Error ? error.message : 'Could not upload.',
          });
      } finally {
        live.current.delete(key);
      }
    },
    [connection, patch],
  );

  const add = useCallback(
    (picked: Picked[]) => {
      const room = MOBILE_MAX_ATTACHMENTS - items.length;
      const accepted = picked.slice(0, Math.max(room, 0)).map((source) => ({
        key: nextKey(),
        name: source.name,
        kind: source.kind,
        status: 'uploading' as const,
        source,
      }));
      setItems((current) => [...current, ...accepted]);
      // Eager: uploading while the user types means Send is usually instant.
      for (const item of accepted) void upload(item.key, item.source);
    },
    [items.length, upload],
  );

  const pickPhotos = useCallback(async () => {
    const ImagePicker = await import('expo-image-picker');
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: Math.max(MOBILE_MAX_ATTACHMENTS - items.length, 1),
      quality: 1,
      base64: false,
    });
    if (result.canceled) return;
    const prepared = await Promise.all(
      result.assets.map((asset, index) =>
        prepareImage({ ...asset, name: asset.fileName ?? `photo-${index + 1}.jpg` }),
      ),
    );
    add(prepared);
  }, [add, items.length]);

  const pickFiles = useCallback(async () => {
    const DocumentPicker = await import('expo-document-picker');
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const prepared = await Promise.all(
      result.assets.map((asset) =>
        // An image picked from Files is still an image: size it for the model like a photo.
        asset.mimeType?.startsWith('image/')
          ? prepareImage({
              uri: asset.uri,
              name: asset.name,
              mimeType: asset.mimeType,
              fileSize: asset.size,
            })
          : Promise.resolve<Picked>({
              uri: asset.uri,
              name: asset.name,
              mimeType: asset.mimeType,
              kind: 'file',
            }),
      ),
    );
    add(prepared);
  }, [add]);

  const remove = useCallback((key: string) => {
    live.current.get(key)?.abort();
    setItems((current) => current.filter((item) => item.key !== key));
  }, []);

  const retry = useCallback(
    (key: string) => {
      const item = items.find((candidate) => candidate.key === key);
      if (item) void upload(key, item.source);
    },
    [items, upload],
  );

  const clear = useCallback(() => setItems([]), []);

  return {
    items,
    /** Ids of everything the computer has stored, in the order it was attached. */
    ids: items.flatMap((item) => (item.status === 'ready' && item.id ? [item.id] : [])),
    uploading: items.some((item) => item.status === 'uploading'),
    failed: items.some((item) => item.status === 'failed'),
    full: items.length >= MOBILE_MAX_ATTACHMENTS,
    pickPhotos,
    pickFiles,
    remove,
    retry,
    clear,
  };
}
