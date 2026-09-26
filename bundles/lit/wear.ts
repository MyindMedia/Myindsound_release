import { setCartridgeDetailHook } from '../../src/player3d/cartridge-detail';
import { CartridgeWear, type WearInput } from '../../src/player3d/wear-render';
import manifest from './bundle.json';
import { LABEL_Z, labelRect } from './edition-stamp';

/**
 * The copy's wear on the cartridge (PRD §11.4, WEAR-4, WEAR-10), drawn by `src/player3d/wear-render.ts` through
 * the deck's optional detail hook. Install before the player mounts (the hook runs while the deck is built), call
 * `set` with `context.wear` and on every `wear` event, and `done` once mounted.
 */
export function installWear(): { set(descriptor: WearInput | null): void; done(): void } {
  let latest: WearInput | null = null;
  let wear: CartridgeWear | null = null;
  setCartridgeDetailHook((input, { coat }) => {
    wear?.dispose();
    wear = new CartridgeWear(input, coat, {
      // Between the label (LABEL_Z) and the edition stamp, so the stamp stays crisp.
      label: { rect: labelRect(), z: LABEL_Z + 0.00015 },
      safeZones: manifest.wearSafeZones,
      quality: input.quality,
    });
    wear.set(latest);
    return wear.spinning;
  });
  return {
    set(descriptor) {
      latest = descriptor;
      wear?.set(descriptor);
    },
    done() {
      setCartridgeDetailHook(null);
    },
  };
}
