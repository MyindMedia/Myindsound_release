import { LoadingManager, SRGBColorSpace, TextureLoader, type Texture } from 'three';
import { KEY_ORDER, type KeyId } from './state';

const BASE = '/assets/images/minidisc/';

export type TextureName =
  | 'body'
  | 'backplate'
  | 'tray'
  | 'glare'
  | 'shell'
  | 'shellBack'
  | 'disc'
  | 'discClear'
  | 'label'
  | `key-${KeyId}`;

const FILES: Record<TextureName, string> = {
  body: 'body.webp',
  backplate: 'backplate.webp',
  tray: 'tray.webp',
  glare: 'glare.webp',
  shell: 'shell.webp',
  shellBack: 'shell-back.webp',
  disc: 'disc.webp',
  discClear: 'disc-clear.webp',
  label: 'label.webp',
  ...(Object.fromEntries(KEY_ORDER.map((id) => [`key-${id}`, `key-${id}.webp`])) as Record<`key-${KeyId}`, string>),
};

export type DeckTextures = Record<TextureName, Texture>;

export function loadDeckTextures(anisotropy: number, onProgress: (ratio: number) => void): Promise<DeckTextures> {
  return new Promise((resolve, reject) => {
    const manager = new LoadingManager();
    const loader = new TextureLoader(manager);
    const textures = {} as DeckTextures;
    manager.onProgress = (_url, loaded, total) => onProgress(loaded / total);
    manager.onLoad = () => resolve(textures);
    manager.onError = (url) => reject(new Error(`Texture failed: ${url}`));
    for (const [name, file] of Object.entries(FILES) as [TextureName, string][]) {
      const texture = loader.load(BASE + file);
      texture.colorSpace = SRGBColorSpace;
      texture.anisotropy = anisotropy;
      textures[name] = texture;
    }
  });
}
