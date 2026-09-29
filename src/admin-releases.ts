/**
 * The release portal: the RELEASES tab on /admin (Grilled.md "Release portal + generated discs", PRD §17 ADM-7).
 * A guided flow for one draft: 1 new release, 2 MP3s, 3 cover, 4 casing (live 3D), 5 rack render (the sleeve
 * still; the spin loop optional), 6 bundle,
 * 7 drop date and publish. Loaded by admin.ts only when the tab opens; three.js and packages/minidisc load later
 * still, at the casing step (`admin-releases-3d.ts`). Every change goes through convex/releases.ts, admin only
 * and audited. No window.confirm or alert: publishing is confirmed in the page, with a reason.
 */
import './admin-releases.css';
import { MAX_IMAGE_STICKERS, MAX_SHUTTER_IMAGE_STICKERS, isKnownDrawnArt } from '../convex/releasesLogic';
import type { Id } from '../convex/_generated/dataModel';
import { STICKER_PRESETS, isDrawnArt, resolveSlideColor } from '../packages/minidisc/src/design';
import { resolvePreset } from '../packages/minidisc/src/presets';
import type { DiscDesign, DiscSticker, LoadedArt, PlaceTarget, ShellSuggestion, SleeveStill, SpinLoopResult } from './admin-releases-3d';
import type { DraftRow, PortalBackend, ReleaseState } from './admin-releases-backend';
import { assembleReleaseZip, type GenericBundleIndex } from './admin-releases-zip';
import { convexErrorMessage } from './convex';

type ThreeModule = typeof import('./admin-releases-3d');
/** An image sticker's own fields, read and written loosely: `packages/minidisc`'s `DiscSticker` owns the real shape. */
type StickerFields = { kind: 'image'; src: string; area: 'shutter' | 'shell'; x: number; y: number; size: number; rotation: number };
const asSticker = (fields: StickerFields): DiscSticker => fields as unknown as DiscSticker;
const stickerFields = (sticker: DiscSticker): StickerFields => sticker as unknown as StickerFields;

const STEPS = ['NEW', 'AUDIO', 'COVER', 'CASING', 'RENDER', 'BUNDLE', 'PUBLISH'] as const;
const MAX_MP3_BYTES = 80 * 1024 * 1024;
const MAX_COVER_BYTES = 25 * 1024 * 1024;
/** Same cap as the cover (releasesLogic UPLOAD_RULES.sticker). */
const MAX_STICKER_BYTES = MAX_COVER_BYTES;
const MIN_COVER_PX = 1024;
const RECOMMENDED_COVER_PX = 1500;
/** Where the site build puts the generic release bundle (scripts/stage-release-bundle.mjs). */
const GENERIC_BUNDLE = '/release-bundle/';

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const errorText = (error: unknown, fallback = 'That did not go through.') =>
  convexErrorMessage(error, error instanceof Error && error.message ? error.message : fallback);
const mmss = (seconds: number) => {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

function setStatus(element: Element | null, message: string, tone: 'ok' | 'error' | 'warn' | '' = '') {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('ok', tone === 'ok');
  element.classList.toggle('error', tone === 'error');
  element.classList.toggle('warn', tone === 'warn');
}

/** "01 - Blood (Final).mp3" → "Blood (Final)". */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
  const stripped = base.replace(/^\s*(?:track\s*)?\d{1,3}(?:\s*[-.)_:]\s*|\s+)/i, '').trim();
  return (stripped || base).slice(0, 120);
}

/** "BLOOD (Deluxe)!" → "blood-deluxe". */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** An MP3's length from its metadata; Web Audio decodes it when the element can't tell (some VBR files). */
async function readDuration(file: File): Promise<number> {
  const url = URL.createObjectURL(file);
  try {
    const fromElement = await new Promise<number>((resolve) => {
      const audio = document.createElement('audio');
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => resolve(audio.duration);
      audio.onerror = () => resolve(Number.NaN);
      audio.src = url;
    });
    if (Number.isFinite(fromElement) && fromElement > 0) return fromElement;
    const context = new AudioContext();
    try {
      const buffer = await context.decodeAudioData(await file.arrayBuffer());
      return buffer.duration;
    } finally {
      void context.close();
    }
  } catch {
    throw new Error(`${file.name}: the length could not be read. Is it an MP3?`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The image could not be read.'));
    image.src = src;
  });
}

/** Local time zone name and offset, for the drop date field ("Europe/London, UTC+01:00"). */
function zoneLabel(at: Date): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  const minutes = -at.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${zone}, UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

type Look = Pick<DiscDesign, 'shell' | 'shellTint' | 'labelStyle' | 'labelText' | 'discFinish' | 'slideColor' | 'labelImage'>;
type LabelPlace = NonNullable<DiscDesign['labelImage']>;
type PlaceField = 'x' | 'y' | 'size' | 'rotation';

/**
 * The slide cover (the metal slide on the shell's left side) is three layers, bottom to top: its colour (the
 * whole slide), the label on it, and the stickers. The colour first: fixed finishes, then the shell's own colour.
 */
const SLIDE_CHOICES: [string, string][] = [
  ['#8b9097', 'STEEL'],
  ['#2b2d33', 'BLACK'],
  ['#c9a227', 'GOLD'],
  ['shell', 'SHELL COLOUR'],
];
/** The label: printed on paper, printed straight on the metal, an uploaded image placed like a sticker, or none. */
type LabelMode = 'sticker' | 'metal' | 'image' | 'none';
const LABEL_CHOICES: [LabelMode, string][] = [
  ['sticker', 'PRINTED LABEL'],
  ['metal', 'PRINTED ON METAL'],
  ['image', 'IMAGE'],
  ['none', 'NONE'],
];
/** The older label styles (`metal-dark`, `tinted`) print on the metal too; their colour now lives in `slideColor`. */
const labelModeOf = (current: Look): LabelMode =>
  current.labelImage ? 'image' : current.labelStyle === 'sticker' ? 'sticker' : current.labelStyle === 'none' ? 'none' : 'metal';
/** Where a label image or a new built-in or emoji sticker starts: centred, square on. */
const LABEL_PLACE = { x: 0.5, y: 0.5, size: 0.9, rotation: 0 };
const DRAWN_PLACE = { x: 0.5, y: 0.5, size: 0.3, rotation: 0 };
const STICKER_EMOJI = ['🔥', '❤️', '⭐', '😀', '⚡', '💿', '🎧', '🎤', '🎶', '👑', '💎', '🚀', '🌈', '✨', '💯', '😎', '🤘', '🙌', '🌙', '☀️', '🍀', '🎉', '💥', '👀'];
const AREA_NAMES: Record<StickerFields['area'], string> = { shutter: 'Slide cover', shell: 'Clear cover (anywhere)' };
const readout = (field: PlaceField, value: number) => (field === 'rotation' ? `${value.toFixed(0)}°` : value.toFixed(2));
/** A drawn sticker's name for its card: the built-in's title, or the emoji itself. */
const drawnName = (ref: string) =>
  ref.startsWith('emoji:') ? ref.slice(6) : (STICKER_PRESETS.find((preset) => `preset:${preset.id}` === ref)?.title ?? 'Sticker');
/** The first emoji (grapheme) of what was typed or pasted. */
const firstGrapheme = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (typeof Intl.Segmenter === 'function') return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)][0]?.segment ?? '';
  return [...trimmed][0] ?? '';
};
const DISC_CHOICES: [NonNullable<DiscDesign['discFinish']>, string][] = [
  ['print', 'ART PRINT'],
  ['vinyl', 'BLACK VINYL'],
  ['rainbow', 'RAINBOW'],
  ['silver', 'SILVER'],
  ['gold', 'GOLD'],
];
type TrackEdit = { id: Id<'tracks'>; title: string; durationSeconds: number; hasAudio: boolean; removed: boolean };

/** Mounts the portal into `root`. Returns nothing; everything it needs comes from `backend`. */
export function mountReleasePortal(root: HTMLElement, backend: PortalBackend): void {
  let three: Promise<ThreeModule> | null = null;
  const loadThree = () => (three ??= import('./admin-releases-3d'));

  // ── Session state ─────────────────────────────────────────────────────────────────────────────────────
  let state: ReleaseState | null = null;
  let step = 0;
  let tracks: TrackEdit[] = [];
  let tracksDirty = false;
  /** The cover uploaded in this session (skips a download for the preview, render and bundle). */
  let localCover: { file: Blob; url: string } | null = null;
  /** The preview's loaded art, keyed by every art ref of the design it was loaded for (`artKey`). */
  let art: { key: string; loaded: LoadedArt } | null = null;
  let artToken = 0;
  /** The three.js module once loaded (the built-in stickers' thumbnails are drawn with it). */
  let threeMod: ThreeModule | null = null;
  let look: Look | null = null;
  let lookDirty = false;
  let suggestion: ShellSuggestion | null = null;
  /** Each shell's own disc finish, for the DISC picker when the design names none. */
  let presetDisc: Record<string, string> = {};
  let sleeveOn = false;
  let preview: ReturnType<ThreeModule['createCasingPreview']> | null = null;
  /** The rack art rendered in this browser and not uploaded yet: the sleeve still, and the optional loop. */
  let render: { still: SleeveStill; loop: SpinLoopResult | null } | null = null;
  let withLoop = false;
  let spriteTimer = 0;
  /** Image stickers (`design.stickers`, kind `image`): uploads matched to their file (for REMOVE), and the drawn
   * built-ins and emoji (no file). Edited and added locally, and only written back on SAVE CASING, like `look`
   * (an upload or a removal saves the casing first, so nothing local is lost). */
  let stickers: { file: Id<'_storage'> | null; sticker: DiscSticker }[] = [];
  /** PLACE mode in the preview (drag the label image and the stickers). */
  let placing = false;
  /** The LABEL layer's IMAGE choice before any label image is uploaded: shows the upload box. */
  let labelPicking = false;
  /** The label image's last placing, kept while a printed label is chosen, for switching back to IMAGE. */
  let lastLabel: LabelPlace | null = null;
  let pickerTab: 'library' | 'emoji' | 'upload' = 'library';
  let addArea: StickerFields['area'] = 'shutter';
  const thumbs = new Map<string, string>();
  let scaleTimer = 0;
  let slideTimer = 0;
  /** Every other sticker kind (text, advisory, badge), carried through unedited: the portal has no UI for them. */
  let otherStickers: DiscSticker[] = [];

  root.innerHTML = `
    <div class="rp">
      <div class="rp-head">
        <h2>RELEASES</h2>
        <button type="button" class="primary-btn rp-new">NEW RELEASE</button>
      </div>
      <div class="rp-drafts">
        <p class="admin-sub">DRAFTS</p>
        <ul class="mono-list rp-draft-list"><li>Loading…</li></ul>
      </div>
      <div class="rp-wizard" hidden>
        <div class="rp-release-head">
          <h3 class="rp-release-title"></h3>
          <button type="button" class="secondary-btn mini-btn rp-close">CLOSE</button>
        </div>
        <ol class="rp-steps" aria-label="Release steps"></ol>
        <section class="rp-step" data-step="0"></section>
        <section class="rp-step" data-step="1" hidden></section>
        <section class="rp-step" data-step="2" hidden></section>
        <section class="rp-step" data-step="3" hidden></section>
        <section class="rp-step" data-step="4" hidden></section>
        <section class="rp-step" data-step="5" hidden></section>
        <section class="rp-step" data-step="6" hidden></section>
        <div class="admin-actions rp-nav">
          <button type="button" class="secondary-btn rp-back">BACK</button>
          <button type="button" class="primary-btn rp-next">NEXT</button>
        </div>
      </div>
    </div>`;

  const $ = <T extends Element = HTMLElement>(selector: string, scope: ParentNode = root) => scope.querySelector<T>(selector)!;
  const section = (index: number) => $<HTMLElement>(`.rp-step[data-step="${index}"]`);
  const wizard = $<HTMLElement>('.rp-wizard');

  // ── Drafts ────────────────────────────────────────────────────────────────────────────────────────────
  const progressOf = (row: DraftRow) =>
    [
      `${row.tracksWithAudio}/${row.tracks} audio`,
      row.hasCover ? 'cover' : 'no cover',
      row.hasDesign ? 'casing' : 'no casing',
      row.rackFresh ? 'rack' : 'no rack',
      row.bundleFresh ? 'bundle' : 'no bundle',
    ].join(' · ');

  async function loadDrafts() {
    const list = $('.rp-draft-list');
    try {
      const rows = await backend.drafts();
      list.innerHTML = rows.length
        ? rows
            .map(
              (row) => `<li>
                <strong>${escapeHtml(row.title)}</strong>
                <span>${escapeHtml(row.slug)}</span>
                <span>${escapeHtml(progressOf(row))}${row.ready ? ' · READY' : ''}</span>
                <button type="button" class="secondary-btn mini-btn" data-resume="${escapeHtml(row.slug)}">RESUME</button>
              </li>`,
            )
            .join('')
        : '<li>No drafts. Start one with NEW RELEASE.</li>';
    } catch (error) {
      list.innerHTML = `<li class="rp-error">${escapeHtml(errorText(error, 'Could not load the drafts.'))}</li>`;
    }
  }

  $('.rp-draft-list').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-resume]');
    if (button) void open(button.dataset.resume!);
  });
  $('.rp-new').addEventListener('click', () => startNew());
  $('.rp-close').addEventListener('click', () => {
    closeRelease();
    void loadDrafts();
  });

  function closeRelease() {
    preview?.dispose();
    preview = null;
    if (localCover) URL.revokeObjectURL(localCover.url);
    localCover = null;
    art = null;
    state = null;
    look = null;
    lookDirty = false;
    suggestion = null;
    sleeveOn = false;
    render = null;
    tracks = [];
    tracksDirty = false;
    stickers = [];
    otherStickers = [];
    placing = false;
    labelPicking = false;
    lastLabel = null;
    stopSprite();
    for (let i = 1; i < STEPS.length; i++) section(i).innerHTML = '';
    wizard.hidden = true;
  }

  function startNew() {
    closeRelease();
    wizard.hidden = false;
    step = 0;
    renderAll();
    $<HTMLInputElement>('input[name="title"]', section(0)).focus();
  }

  async function open(slug: string, atStep?: number) {
    closeRelease();
    wizard.hidden = false;
    try {
      state = await backend.get(slug);
    } catch (error) {
      wizard.hidden = true;
      setStatus($('.rp-draft-list'), errorText(error, 'Could not open that draft.'), 'error');
      return;
    }
    syncTracks();
    syncStickers();
    step = atStep ?? firstOpenStep();
    renderAll();
    wizard.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  async function refresh() {
    if (!state) return;
    state = await backend.get(state.slug);
    if (!tracksDirty) syncTracks();
    // Unsaved casing edits stay local (uploads and removals save them first, so the server already has them).
    if (!lookDirty) {
      syncStickers();
      if (look) look = { ...look, labelImage: state.design?.labelImage };
    }
    renderAll();
    void loadDrafts();
  }

  function syncTracks() {
    tracks = (state?.tracks ?? []).map((t) => ({ id: t.id, title: t.title, durationSeconds: t.durationSeconds, hasAudio: t.hasAudio, removed: false }));
    tracksDirty = false;
  }

  /** Rebuilds `stickers`/`otherStickers` from the saved design (drops unsaved slider drags: SAVE CASING first). */
  function syncStickers() {
    const files = state?.stickerFiles ?? [];
    const all = (state?.design?.stickers ?? []) as DiscSticker[];
    otherStickers = all.filter((sticker) => stickerFields(sticker).kind !== 'image');
    stickers = all
      .filter((sticker) => stickerFields(sticker).kind === 'image')
      .flatMap((sticker): { file: Id<'_storage'> | null; sticker: DiscSticker }[] => {
        const src = stickerFields(sticker).src;
        if (isDrawnArt(src)) return [{ file: null, sticker }];
        const match = files.find((f) => f.url === src);
        return match ? [{ file: match.file, sticker }] : [];
      });
  }

  // ── Steps ─────────────────────────────────────────────────────────────────────────────────────────────
  type StepState = 'done' | 'stale' | 'todo';
  function stepState(index: number): StepState {
    const s = state;
    if (!s) return 'todo';
    switch (index) {
      case 0:
        return 'done';
      case 1:
        return s.tracks.length > 0 && s.tracks.every((t) => t.hasAudio) ? 'done' : 'todo';
      case 2:
        return s.coverUrl ? 'done' : 'todo';
      case 3:
        return s.designHash ? 'done' : s.design ? 'stale' : 'todo';
      case 4:
        return s.rack?.fresh ? 'done' : s.rack ? 'stale' : 'todo';
      case 5:
        return s.bundle?.fresh ? 'done' : s.bundle ? 'stale' : 'todo';
      default:
        return s.status !== 'draft' ? 'done' : 'todo';
    }
  }
  const firstOpenStep = () => {
    for (let i = 1; i < STEPS.length; i++) if (stepState(i) !== 'done') return i;
    return STEPS.length - 1;
  };

  function renderSteps() {
    const list = $('.rp-steps');
    list.innerHTML = STEPS.map((label, i) => {
      const s = stepState(i);
      const mark = s === 'done' ? 'DONE' : s === 'stale' ? 'REDO' : '';
      return `<li><button type="button" class="rp-step-btn ${s}" data-go="${i}" ${i === step ? 'aria-current="step"' : ''} ${!state && i > 0 ? 'disabled' : ''}>
        <span class="rp-step-n">${i + 1}</span><span>${label}</span>${mark ? `<span class="rp-step-mark">${mark}</span>` : ''}
      </button></li>`;
    }).join('');
  }
  $('.rp-steps').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-go]');
    if (button && !button.disabled) goTo(Number(button.dataset.go));
  });
  $('.rp-back').addEventListener('click', () => goTo(step - 1));
  $('.rp-next').addEventListener('click', () => goTo(step + 1));

  function goTo(index: number) {
    if (index < 0 || index >= STEPS.length || (!state && index > 0)) return;
    step = index;
    renderAll();
    $('.rp-steps').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function renderAll() {
    $('.rp-release-title').textContent = state
      ? `${state.title} · ${state.artist ?? ''} · ${state.year ?? ''} · ${state.status.toUpperCase()}`
      : 'NEW RELEASE';
    renderSteps();
    for (let i = 0; i < STEPS.length; i++) section(i).hidden = i !== step;
    $<HTMLButtonElement>('.rp-back').disabled = step === 0;
    $<HTMLButtonElement>('.rp-next').disabled = step === STEPS.length - 1 || !state;
    if (step !== 4) stopSprite();
    [renderNew, renderAudio, renderCover, renderCasing, renderRender, renderBundle, renderPublish][step]();
  }

  // ── 1. New release ────────────────────────────────────────────────────────────────────────────────────
  function renderNew() {
    const el = section(0);
    if (state) {
      el.innerHTML = `
        <dl class="readout">
          <div><dt>Slug</dt><dd>${escapeHtml(state.slug)}</dd></div>
          <div><dt>Title</dt><dd>${escapeHtml(state.title)}</dd></div>
          <div><dt>Artist</dt><dd>${escapeHtml(state.artist ?? '—')}</dd></div>
          <div><dt>Year</dt><dd>${escapeHtml(String(state.year ?? '—'))}</dd></div>
          <div><dt>Status</dt><dd>${escapeHtml(state.status)}</dd></div>
        </dl>
        <p class="admin-sub">These are fixed once the draft exists. Start a new draft to change them.</p>`;
      return;
    }
    el.innerHTML = `
      <form class="admin-form rp-new-form" novalidate>
        <label class="field"><span>Title</span><input name="title" maxlength="80" autocomplete="off" required></label>
        <label class="field"><span>Artist</span><input name="artist" maxlength="80" autocomplete="off" value="Tha Myind" required></label>
        <label class="field"><span>Year</span><input name="year" type="number" min="1900" max="2100" step="1" value="${new Date().getFullYear()}" required></label>
        <label class="field"><span>Slug (the app and bundle name)</span><input name="slug" maxlength="64" autocomplete="off" spellcheck="false" pattern="[a-z0-9][a-z0-9-]*" required></label>
        <div class="admin-actions"><button class="primary-btn" type="submit">CREATE DRAFT</button></div>
        <p class="admin-status" role="status" aria-live="polite"></p>
      </form>`;
    const form = $<HTMLFormElement>('form', el);
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    let slugEdited = false;
    field('slug').addEventListener('input', () => (slugEdited = true));
    field('title').addEventListener('input', () => {
      if (!slugEdited) field('slug').value = slugify(field('title').value);
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = $('.admin-status', form);
      const args = {
        slug: field('slug').value.trim(),
        title: field('title').value.trim(),
        artist: field('artist').value.trim(),
        year: Number(field('year').value),
      };
      if (!args.title || !args.artist || !args.slug) return setStatus(status, 'Title, artist and slug are required.', 'error');
      const button = $<HTMLButtonElement>('button[type="submit"]', form);
      button.disabled = true;
      setStatus(status, 'Creating…');
      try {
        await backend.createDraft(args);
        void loadDrafts();
        await open(args.slug, 1);
      } catch (error) {
        button.disabled = false;
        setStatus(status, errorText(error), 'error');
      }
    });
  }

  // ── 2. Audio ──────────────────────────────────────────────────────────────────────────────────────────
  function renderAudio() {
    const el = section(1);
    el.innerHTML = `
      <label class="rp-drop" tabindex="0">
        <input type="file" accept=".mp3,audio/mpeg" multiple class="rp-file">
        <strong>DROP MP3s HERE</strong>
        <span>or click to choose. Several at once is fine; they go on in file name order.</span>
      </label>
      <ul class="mono-list rp-queue"></ul>
      <p class="admin-sub">TRACKLIST</p>
      <ol class="rp-tracks">${
        tracks.length
          ? tracks
              .map(
                (track, i) => `<li class="rp-track${track.removed ? ' removed' : ''}" data-index="${i}">
                  <span class="rp-track-n">${String(i + 1).padStart(2, '0')}</span>
                  <input class="rp-track-title" value="${escapeHtml(track.title)}" maxlength="120" aria-label="Title of track ${i + 1}" ${track.removed ? 'disabled' : ''}>
                  <span class="rp-track-time">${track.hasAudio ? mmss(track.durationSeconds) : 'NO AUDIO'}</span>
                  <span class="rp-track-tools">
                    <button type="button" class="secondary-btn mini-btn" data-move="-1" aria-label="Move track ${i + 1} up" ${i === 0 ? 'disabled' : ''}>UP</button>
                    <button type="button" class="secondary-btn mini-btn" data-move="1" aria-label="Move track ${i + 1} down" ${i === tracks.length - 1 ? 'disabled' : ''}>DOWN</button>
                    <button type="button" class="secondary-btn mini-btn" data-remove aria-pressed="${track.removed}">${track.removed ? 'KEEP' : 'REMOVE'}</button>
                  </span>
                </li>`,
              )
              .join('')
          : '<li class="rp-empty">No tracks yet.</li>'
      }</ol>
      <div class="admin-actions">
        <button type="button" class="primary-btn rp-save-tracks" ${tracksDirty ? '' : 'disabled'}>SAVE ORDER AND TITLES</button>
      </div>
      <div class="confirm-strip danger rp-tracks-confirm" hidden></div>
      <p class="admin-status rp-tracks-status" role="status" aria-live="polite"></p>`;

    const input = $<HTMLInputElement>('.rp-file', el);
    const drop = $<HTMLElement>('.rp-drop', el);
    input.addEventListener('change', () => void uploadAudio([...(input.files ?? [])]));
    wireDrop(drop, (files) => void uploadAudio(files));

    const list = $('.rp-tracks', el);
    list.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      const row = target.closest<HTMLElement>('[data-index]');
      if (!row || !target.classList.contains('rp-track-title')) return;
      tracks[Number(row.dataset.index)].title = target.value;
      markTracksDirty();
    });
    list.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
      const row = button?.closest<HTMLElement>('[data-index]');
      if (!button || !row) return;
      const index = Number(row.dataset.index);
      if (button.dataset.move) {
        const to = index + Number(button.dataset.move);
        [tracks[index], tracks[to]] = [tracks[to], tracks[index]];
        tracksDirty = true;
        renderAudio();
        $<HTMLButtonElement>(`[data-index="${to}"] [data-move="${button.dataset.move}"]`, section(1))?.focus();
      } else if (button.hasAttribute('data-remove')) {
        tracks[index].removed = !tracks[index].removed;
        tracksDirty = true;
        renderAudio();
      }
    });
    $('.rp-save-tracks', el).addEventListener('click', () => reviewTracks());
  }

  function markTracksDirty() {
    tracksDirty = true;
    const save = $<HTMLButtonElement>('.rp-save-tracks', section(1));
    if (save) save.disabled = false;
    $<HTMLElement>('.rp-tracks-confirm', section(1)).hidden = true;
  }

  function reviewTracks() {
    const el = section(1);
    const status = $('.rp-tracks-status', el);
    const kept = tracks.filter((t) => !t.removed);
    if (kept.some((t) => !t.title.trim())) return setStatus(status, 'Every track needs a title.', 'error');
    const removed = tracks.filter((t) => t.removed);
    const save = async () => {
      setStatus(status, 'Saving…');
      try {
        await backend.setTracks({ slug: state!.slug, tracks: kept.map((t) => ({ trackId: t.id, title: t.title.trim() })) });
        tracksDirty = false;
        await refresh();
        setStatus($('.rp-tracks-status', section(1)), 'Saved.', 'ok');
      } catch (error) {
        setStatus(status, errorText(error), 'error');
      }
    };
    if (removed.length === 0) return void save();
    const strip = $<HTMLElement>('.rp-tracks-confirm', el);
    strip.innerHTML = `
      <strong class="admin-sub">Remove ${removed.length} track${removed.length === 1 ? '' : 's'} and delete the audio?</strong>
      <ul>${removed.map((t) => `<li>${escapeHtml(t.title)}</li>`).join('')}</ul>
      <div class="admin-actions">
        <button type="button" class="primary-btn" data-confirm>CONFIRM</button>
        <button type="button" class="secondary-btn" data-cancel>CANCEL</button>
      </div>`;
    strip.hidden = false;
    $<HTMLButtonElement>('[data-confirm]', strip).focus();
    $('[data-cancel]', strip).addEventListener('click', () => {
      strip.hidden = true;
      setStatus(status, 'Cancelled. Nothing was changed.');
    });
    $('[data-confirm]', strip).addEventListener('click', () => {
      strip.hidden = true;
      void save();
    });
  }

  async function uploadAudio(files: File[]) {
    if (!state || files.length === 0) return;
    const slug = state.slug;
    const queue = $('.rp-queue', section(1));
    const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const rows = sorted.map((file) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="rp-q-name">${escapeHtml(file.name)}</span><progress max="1" value="0"></progress><span class="rp-q-state">WAITING</span>`;
      queue.append(li);
      return { file, li };
    });
    const failures: string[] = [];
    // One at a time, so the tracks go on in the order shown.
    for (const { file, li } of rows) {
      const stateText = $('.rp-q-state', li);
      const bar = $<HTMLProgressElement>('progress', li);
      try {
        const isMp3 = file.type === 'audio/mpeg' || file.type === 'audio/mp3' || /\.mp3$/i.test(file.name);
        if (!isMp3) throw new Error('Not an MP3.');
        if (file.size > MAX_MP3_BYTES) throw new Error(`${mb(file.size)} is over the 80 MB limit.`);
        stateText.textContent = 'READING';
        const durationSec = await readDuration(file);
        stateText.textContent = `${mmss(durationSec)} · UPLOADING`;
        const id = await backend.upload(slug, file, 'audio/mpeg', (fraction) => (bar.value = fraction));
        stateText.textContent = 'CHECKING';
        const result = await backend.attachTrackAudio({ slug, file: id, durationSec, title: titleFromFileName(file.name) });
        stateText.textContent = `TRACK ${result.position} · DONE`;
        li.classList.add('ok');
      } catch (error) {
        stateText.textContent = errorText(error, 'Failed.');
        li.classList.add('rp-error');
        failures.push(`${file.name}: ${errorText(error, 'failed')}`);
      }
    }
    await refresh();
    const summary = `${rows.length - failures.length} of ${rows.length} uploaded.${failures.length ? ` ${failures.join(' ')}` : ''}`;
    setStatus($('.rp-tracks-status', section(1)), summary, failures.length ? 'error' : 'ok');
  }

  function wireDrop(zone: HTMLElement, onFiles: (files: File[]) => void) {
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('over');
      onFiles([...(event.dataTransfer?.files ?? [])]);
    });
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        zone.querySelector<HTMLInputElement>('input[type="file"]')?.click();
      }
    });
  }

  // ── 3. Cover ──────────────────────────────────────────────────────────────────────────────────────────
  function renderCover() {
    const el = section(2);
    const src = localCover?.url ?? state?.coverUrl ?? null;
    el.innerHTML = `
      <div class="rp-cover-grid">
        <div class="rp-cover-frame">${src ? `<img src="${escapeHtml(src)}" alt="Cover art" class="rp-cover-img">` : '<span>NO COVER YET</span>'}</div>
        <div>
          <label class="rp-drop" tabindex="0">
            <input type="file" accept="image/png,image/jpeg,image/webp" class="rp-file">
            <strong>DROP THE COVER HERE</strong>
            <span>Square PNG, JPEG or WebP. At least ${MIN_COVER_PX} px; ${RECOMMENDED_COVER_PX} px or more prints sharp on the sleeve.</span>
          </label>
          <progress class="rp-cover-progress" max="1" value="0" hidden></progress>
          <p class="admin-status rp-cover-status" role="status" aria-live="polite"></p>
        </div>
      </div>`;
    const input = $<HTMLInputElement>('.rp-file', el);
    input.addEventListener('change', () => input.files?.[0] && void uploadCover(input.files[0]));
    wireDrop($('.rp-drop', el), (files) => files[0] && void uploadCover(files[0]));
  }

  async function uploadCover(file: File) {
    if (!state) return;
    const el = section(2);
    const status = $('.rp-cover-status', el);
    const bar = $<HTMLProgressElement>('.rp-cover-progress', el);
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setStatus(status, 'Use a PNG, JPEG or WebP image.', 'error');
    if (file.size > MAX_COVER_BYTES) return setStatus(status, `${mb(file.size)} is over the 25 MB limit.`, 'error');
    const url = URL.createObjectURL(file);
    let image: HTMLImageElement;
    try {
      image = await loadImage(url);
    } catch (error) {
      URL.revokeObjectURL(url);
      return setStatus(status, errorText(error), 'error');
    }
    const { naturalWidth: w, naturalHeight: h } = image;
    if (Math.abs(w - h) > Math.max(w, h) * 0.01) {
      URL.revokeObjectURL(url);
      return setStatus(status, `The cover must be square (this one is ${w} × ${h}).`, 'error');
    }
    if (w < MIN_COVER_PX) {
      URL.revokeObjectURL(url);
      return setStatus(status, `The cover must be at least ${MIN_COVER_PX} px (this one is ${w} px).`, 'error');
    }
    const warning = w < RECOMMENDED_COVER_PX ? ` Heads up: ${w} px is below ${RECOMMENDED_COVER_PX} px, so the sleeve print will be soft.` : '';
    bar.hidden = false;
    setStatus(status, `Uploading ${w} × ${h}…`);
    try {
      const id = await backend.upload(state.slug, file, file.type, (fraction) => (bar.value = fraction));
      setStatus(status, 'Checking…');
      await backend.attachCover({ slug: state.slug, file: id });
      if (localCover) URL.revokeObjectURL(localCover.url);
      localCover = { file, url };
      // A new cover: the casing step starts over on it (keeping any unsaved shell and label choices).
      art = null;
      suggestion = null;
      render = null;
      preview?.dispose();
      preview = null;
      section(3).innerHTML = '';
      if (!lookDirty) look = null;
      await refresh();
      setStatus($('.rp-cover-status', section(2)), `Cover saved: ${w} × ${h}.${warning}`, warning ? 'warn' : 'ok');
    } catch (error) {
      URL.revokeObjectURL(url);
      bar.hidden = true;
      setStatus(status, errorText(error), 'error');
    }
  }

  // ── 4. Casing ─────────────────────────────────────────────────────────────────────────────────────────

  /** The cover as the portal's pages can read it (the local file when there is one). */
  const coverSrc = () => localCover?.url ?? state?.coverUrl ?? null;
  const allStickers = () => [...otherStickers, ...stickers.map((entry) => entry.sticker)];

  /** A full DiscDesign for the preview and the render, with the cover at `src`. */
  function designWith(current: Look, src: string): DiscDesign {
    const s = state!;
    const base = (s.design ?? {}) as Partial<DiscDesign>;
    return {
      ...base,
      v: 1,
      slug: s.slug,
      title: s.title,
      artist: s.artist ?? '',
      year: s.year ?? new Date().getFullYear(),
      tracks: s.tracks.map((t) => ({ n: t.position, title: t.title, durationSec: t.durationSeconds })),
      coverArt: src,
      discArt: undefined,
      stickers: allStickers(),
      shell: current.shell,
      shellTint: current.shellTint,
      slideColor: current.slideColor,
      labelStyle: current.labelStyle,
      labelText: current.labelText,
      labelImage: current.labelImage,
      discFinish: current.discFinish,
    };
  }

  /** Every art ref the design loads (the cover, the label image, each image sticker): the art cache's key. */
  const artKey = (design: DiscDesign) =>
    JSON.stringify([
      design.coverArt,
      design.labelImage?.src ?? null,
      ((design.stickers ?? []) as DiscSticker[]).map(stickerFields).filter((f) => f.kind === 'image').map((f) => f.src),
    ]);

  /** The design's art, loaded once per set of refs (a new sticker or label image loads it again). */
  async function artFor(design: DiscDesign): Promise<LoadedArt> {
    const key = artKey(design);
    if (art?.key === key) return art.loaded;
    const mod = await loadThree();
    await mod.ready();
    const loaded = await mod.loadDesignArt(design);
    art = { key, loaded };
    return loaded;
  }

  /** The shell's own colour (its gel, with the design's tint), for the SHELL COLOUR slide. */
  const shellGel = (current: Pick<Look, 'shell' | 'shellTint'>) => resolvePreset(current.shell, current.shellTint).gel;
  /** The slide's colour as the preview draws it (older designs: what their label style implied). */
  const slideOf = (current: Look) => resolveSlideColor(current, shellGel(current));

  function renderCasing() {
    const el = section(3);
    const s = state!;
    if (!s.coverUrl || s.tracks.length === 0) {
      el.innerHTML = '<p class="admin-sub">Upload the tracks and the cover first (steps 2 and 3).</p>';
      return;
    }
    if (!el.querySelector('.rp-casing')) {
      el.innerHTML = `
        <div class="rp-casing">
          <div class="rp-stage">
            <canvas class="rp-canvas" tabindex="0" aria-label="Live 3D preview of the MiniDisc. Drag or use the arrow keys to turn it; double-click to reset. In PLACE mode, drag the label image or a sticker to move it."></canvas>
            <p class="rp-stage-note admin-sub">LOADING 3D…</p>
            <div class="admin-actions rp-stage-tools">
              <button type="button" class="secondary-btn mini-btn rp-sleeve" aria-pressed="false">SHOW SLEEVE</button>
              <button type="button" class="secondary-btn mini-btn rp-reset">FACE FRONT</button>
              <button type="button" class="secondary-btn mini-btn rp-place" aria-pressed="false">PLACE</button>
            </div>
          </div>
          <div class="rp-controls">
            <p class="admin-sub">SHELL</p>
            <div class="rp-swatches" role="radiogroup" aria-label="Shell"></div>
            <p class="admin-sub">CLEAR CASE COLOUR <span class="rp-layer-note">the tint of the plastic case</span></p>
            <div class="rp-tints" role="radiogroup" aria-label="Clear case colour">
              <button type="button" class="secondary-btn mini-btn" role="radio" data-tint="preset"><span class="rp-chip small rp-tint-preset-chip"></span>PRESET</button>
              <button type="button" class="secondary-btn mini-btn" role="radio" data-tint="cover" hidden><span class="rp-chip small rp-tint-cover-chip"></span>FROM COVER</button>
              <label class="secondary-btn mini-btn rp-colour-pick" data-tint-custom><span class="rp-chip small rp-tint-custom-chip"></span>CUSTOM
                <input type="color" class="rp-colour-input rp-tint-custom" aria-label="Custom clear case colour">
              </label>
            </div>
            <p class="admin-sub">DISC</p>
            <div class="rp-discs" role="radiogroup" aria-label="Disc finish">
              ${DISC_CHOICES.map(([finish, name]) => `<button type="button" class="secondary-btn mini-btn" role="radio" data-disc="${finish}">${name}</button>`).join('')}
            </div>
            <section class="rp-layer" aria-labelledby="rp-layer-slide">
              <p class="admin-sub rp-layer-head" id="rp-layer-slide"><span class="rp-layer-n">1</span> SLIDE COLOUR <span class="rp-layer-note">the whole slide cover</span></p>
              <div class="rp-slides" role="radiogroup" aria-label="Slide colour">
                ${SLIDE_CHOICES.map(
                  ([colour, name]) =>
                    `<button type="button" class="secondary-btn mini-btn" role="radio" data-slide="${colour}"><span class="rp-chip small"${colour === 'shell' ? '' : ` style="--chip:${colour};--chip2:${colour}"`}></span>${name}</button>`,
                ).join('')}
                <label class="secondary-btn mini-btn rp-colour-pick" data-slide-custom><span class="rp-chip small rp-slide-custom-chip"></span>CUSTOM
                  <input type="color" class="rp-colour-input rp-slide-custom" aria-label="Custom slide colour">
                </label>
              </div>
            </section>
            <section class="rp-layer" aria-labelledby="rp-layer-label">
              <p class="admin-sub rp-layer-head" id="rp-layer-label"><span class="rp-layer-n">2</span> LABEL <span class="rp-layer-note">on the slide</span></p>
              <div class="rp-labels" role="radiogroup" aria-label="Label">
                ${LABEL_CHOICES.map(([mode, name]) => `<button type="button" class="secondary-btn mini-btn" role="radio" data-label="${mode}">${name}</button>`).join('')}
              </div>
              <label class="field rp-label-text-field"><span>Label text (optional, one line each)</span><textarea class="rp-label-text" maxlength="160" rows="3" placeholder="${escapeHtml(`${s.title}\n${s.artist ?? ''}`)}"></textarea></label>
              <div class="rp-label-image"></div>
            </section>
            <section class="rp-layer" aria-labelledby="rp-layer-stickers">
              <p class="admin-sub rp-layer-head" id="rp-layer-stickers"><span class="rp-layer-n">3</span> STICKERS <span class="rp-layer-note">on top, on the slide or the clear cover</span></p>
              <div class="rp-stickers"></div>
            </section>
            <div class="admin-actions"><button type="button" class="primary-btn rp-save-look">SAVE CASING</button></div>
            <p class="admin-status rp-look-status" role="status" aria-live="polite"></p>
          </div>
        </div>`;
      void setupCasing();
    } else updateCasingControls();
  }

  async function setupCasing() {
    const el = section(3);
    const note = $('.rp-stage-note', el);
    let mod: ThreeModule;
    let loaded: LoadedArt;
    try {
      mod = await loadThree();
      threeMod = mod;
      const src = coverSrc();
      if (!src) throw new Error('Upload the cover first.');
      loaded = await artFor(designWith({ shell: 'clear', labelStyle: 'none' }, src));
    } catch (error) {
      note.textContent = errorText(error, 'The 3D preview could not start.');
      return;
    }
    if (!el.isConnected || !state) return;
    suggestion ??= mod.suggestShell(loaded.cover);
    const saved = state.design;
    look ??= saved
      ? {
          shell: saved.shell,
          shellTint: saved.shellTint,
          slideColor: saved.slideColor,
          labelStyle: saved.labelStyle,
          labelText: saved.labelText,
          labelImage: saved.labelImage,
          discFinish: saved.discFinish,
        }
      : { shell: suggestion.shell, shellTint: suggestion.tint, labelStyle: 'sticker', labelText: undefined, labelImage: undefined, discFinish: undefined };
    presetDisc = Object.fromEntries(mod.SHELL_PRESET_LIST.map((preset) => [preset.id, preset.disc]));
    const swatches = $('.rp-swatches', el);
    swatches.innerHTML = mod.SHELL_PRESET_LIST.map(
      (preset) => `<button type="button" class="rp-swatch" role="radio" data-shell="${preset.id}" aria-label="${escapeHtml(preset.label)}">
        <span class="rp-chip" style="--chip:${preset.gel};--chip2:${preset.colour}"></span>
        <span class="rp-swatch-label">${escapeHtml(preset.label)}</span>
        ${preset.id === suggestion!.shell ? '<span class="rp-suggested">SUGGESTED</span>' : ''}
      </button>`,
    ).join('');
    swatches.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-shell]');
      if (!button || !look) return;
      const shell = button.dataset.shell as Look['shell'];
      // The suggested tint belongs to the suggested shell (another starts plain); a custom plastic colour stays.
      const custom = look.shellTint && look.shellTint !== suggestion?.tint ? look.shellTint : undefined;
      changeLook({ shell, shellTint: custom ?? (shell === suggestion?.shell ? suggestion?.tint : undefined) });
    });
    $('.rp-tints', el).addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tint]');
      if (!button || !look) return;
      changeLook({ shellTint: button.dataset.tint === 'cover' ? suggestion?.tint : undefined });
    });
    let tinting = 0;
    $<HTMLInputElement>('.rp-tint-custom', el).addEventListener('input', (event) => {
      const value = (event.target as HTMLInputElement).value;
      window.clearTimeout(tinting);
      tinting = window.setTimeout(() => changeLook({ shellTint: value.toLowerCase() }), 120);
    });
    $('.rp-slides', el).addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-slide]');
      if (!button || !look) return;
      const colour = button.dataset.slide!;
      changeLook({ slideColor: colour === 'shell' ? shellGel(look) : colour });
    });
    $<HTMLInputElement>('.rp-slide-custom', el).addEventListener('input', (event) => {
      const value = (event.target as HTMLInputElement).value;
      // The picker fires on every step of a drag; the cartridge rebuilds once it settles.
      window.clearTimeout(slideTimer);
      slideTimer = window.setTimeout(() => changeLook({ slideColor: value.toLowerCase() }), 120);
    });
    $('.rp-labels', el).addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-label]');
      if (button) pickLabel(button.dataset.label as LabelMode);
    });
    $('.rp-discs', el).addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-disc]');
      if (button) changeLook({ discFinish: button.dataset.disc as Look['discFinish'] });
    });
    let typing = 0;
    $<HTMLTextAreaElement>('.rp-label-text', el).addEventListener('input', (event) => {
      const value = (event.target as HTMLTextAreaElement).value;
      window.clearTimeout(typing);
      typing = window.setTimeout(() => changeLook({ labelText: value.trim() ? value : undefined }), 350);
    });
    $('.rp-save-look', el).addEventListener('click', () => void saveLook());
    wireLabel(el);
    wireStickers(el);
    $('.rp-sleeve', el).addEventListener('click', (event) => {
      sleeveOn = !sleeveOn;
      (event.currentTarget as HTMLElement).setAttribute('aria-pressed', String(sleeveOn));
      (event.currentTarget as HTMLElement).textContent = sleeveOn ? 'HIDE SLEEVE' : 'SHOW SLEEVE';
      preview?.setSleeve(sleeveOn);
    });
    $('.rp-reset', el).addEventListener('click', () => preview?.reset());
    $('.rp-place', el).addEventListener('click', () => setPlacing(!placing));
    const sleeveButton = $('.rp-sleeve', el);
    sleeveButton.setAttribute('aria-pressed', String(sleeveOn));
    sleeveButton.textContent = sleeveOn ? 'HIDE SLEEVE' : 'SHOW SLEEVE';
    try {
      preview = mod.createCasingPreview($<HTMLCanvasElement>('.rp-canvas', el), { onPlace: placed, onScale: scaled });
      preview.setSleeve(sleeveOn);
      setPlacing(placing);
    } catch (error) {
      note.textContent = errorText(error, 'WebGL is not available in this browser.');
    }
    $<HTMLTextAreaElement>('.rp-label-text', el).value = look.labelText ?? '';
    updateCasingControls();
    showPreview();
  }

  function changeLook(patch: Partial<Look>) {
    if (!look) return;
    const next = { ...look, ...patch };
    // A slide in the shell's colour follows the shell (and its tint) when either changes.
    if (('shell' in patch || 'shellTint' in patch) && !('slideColor' in patch) && look.slideColor?.toLowerCase() === shellGel(look).toLowerCase()) {
      next.slideColor = shellGel(next);
    }
    look = next;
    lookDirty = true;
    updateCasingControls();
    showPreview();
  }

  function showPreview() {
    const src = coverSrc();
    if (!preview || !look || !src) return;
    const design = designWith(look, src);
    if (art?.key !== artKey(design)) {
      // New art (a sticker or a label image): load it, then show whatever the design is by then.
      const token = ++artToken;
      artFor(design).then(
        () => token === artToken && showPreview(),
        (error) => setStatus($('.rp-look-status', section(3)), errorText(error, 'The preview could not load the art.'), 'error'),
      );
      return;
    }
    try {
      preview.show(design, art.loaded);
    } catch (error) {
      setStatus($('.rp-look-status', section(3)), errorText(error, 'The preview failed.'), 'error');
    }
  }

  function setPlacing(on: boolean) {
    placing = on;
    preview?.setPlacing(on);
    const button = section(3).querySelector<HTMLElement>('.rp-place');
    if (button) {
      button.setAttribute('aria-pressed', String(on));
      button.textContent = on ? 'DONE PLACING' : 'PLACE';
    }
    const note = section(3).querySelector('.rp-stage-note');
    if (note && preview) {
      note.textContent = on
        ? 'DRAG THE LABEL IMAGE OR A STICKER TO MOVE IT · SCROLL OR PINCH TO RESIZE'
        : 'DRAG TO TURN · DOUBLE-CLICK TO RESET · PLACE TO MOVE STICKERS';
    }
  }

  /** The preview moved the label image or a sticker (PLACE mode): the sliders follow, and it rebuilds on release. */
  function placed(target: PlaceTarget, x: number, y: number, done: boolean) {
    if (!look) return;
    if (target.layer === 'label') {
      if (!look.labelImage) return;
      look = { ...look, labelImage: { ...look.labelImage, x, y } };
      syncCard(null);
    } else {
      const i = (target.index ?? -1) - otherStickers.length;
      if (!stickers[i]) return;
      stickers[i] = { ...stickers[i], sticker: asSticker({ ...stickerFields(stickers[i].sticker), x, y }) };
      syncCard(i);
    }
    lookDirty = true;
    updateLookStatus();
    if (done) showPreview();
  }

  /** A wheel turn or a pinch in PLACE mode: resize the last picked one; the cartridge rebuilds once it settles. */
  function scaled(target: PlaceTarget, factor: number) {
    if (!look) return;
    const size = (value: number) => Math.max(0.05, Math.min(1, Math.round(value * factor * 1000) / 1000));
    if (target.layer === 'label') {
      if (!look.labelImage) return;
      look = { ...look, labelImage: { ...look.labelImage, size: size(look.labelImage.size) } };
      syncCard(null);
    } else {
      const i = (target.index ?? -1) - otherStickers.length;
      if (!stickers[i]) return;
      const fields = stickerFields(stickers[i].sticker);
      stickers[i] = { ...stickers[i], sticker: asSticker({ ...fields, size: size(fields.size) }) };
      syncCard(i);
    }
    lookDirty = true;
    updateLookStatus();
    window.clearTimeout(scaleTimer);
    scaleTimer = window.setTimeout(showPreview, 150);
  }

  /** Sets a card's sliders and readouts from the model: the label image's (`null`) or sticker `i`'s. */
  function syncCard(i: number | null) {
    const card = section(3).querySelector<HTMLElement>(i === null ? '.rp-label-card' : `.rp-sticker[data-i="${i}"]`);
    const place = i === null ? look?.labelImage : stickers[i] ? stickerFields(stickers[i].sticker) : null;
    if (!card || !place) return;
    for (const input of card.querySelectorAll<HTMLInputElement>('input[type="range"][data-field]')) {
      const field = input.dataset.field as PlaceField;
      const value = field === 'rotation' ? (place.rotation ?? 0) : place[field];
      input.value = String(value);
      const out = input.closest('label')?.querySelector('.rp-sticker-readout');
      if (out) out.textContent = readout(field, value);
    }
  }

  function updateLookStatus() {
    const status = section(3).querySelector('.rp-look-status');
    if (!status || status.classList.contains('error')) return;
    const saved = state?.designHash ? `Saved (revision ${state.designRev}).` : 'Not saved yet.';
    setStatus(status, lookDirty ? `Unsaved changes. ${saved}` : saved, lookDirty ? 'warn' : state?.designHash ? 'ok' : '');
  }

  function updateCasingControls() {
    const el = section(3);
    if (!look) return;
    for (const button of el.querySelectorAll<HTMLElement>('[data-shell]')) {
      const on = button.dataset.shell === look.shell;
      button.setAttribute('aria-checked', String(on));
      button.classList.toggle('on', on);
    }
    // The slide's colour: the matching choice, else CUSTOM (older designs show what their label style implied).
    const slide = slideOf(look).toLowerCase();
    const gel = shellGel(look).toLowerCase();
    const shellSwatch = el.querySelector<HTMLElement>('[data-slide="shell"] .rp-chip');
    shellSwatch?.style.setProperty('--chip', gel);
    shellSwatch?.style.setProperty('--chip2', gel);
    const fixed = SLIDE_CHOICES.find(([colour]) => colour !== 'shell' && colour === slide)?.[0] ?? (slide === gel ? 'shell' : null);
    for (const button of el.querySelectorAll<HTMLElement>('[data-slide]')) {
      button.setAttribute('aria-checked', String(button.dataset.slide === fixed));
    }
    const custom = el.querySelector<HTMLElement>('[data-slide-custom]');
    if (custom) {
      custom.setAttribute('aria-checked', String(fixed === null));
      custom.querySelector<HTMLElement>('.rp-slide-custom-chip')?.style.setProperty('--chip', slide);
      custom.querySelector<HTMLElement>('.rp-slide-custom-chip')?.style.setProperty('--chip2', slide);
      const input = custom.querySelector<HTMLInputElement>('.rp-slide-custom');
      if (input && document.activeElement !== input) input.value = slide;
    }
    const mode = labelPicking && !look.labelImage ? 'image' : labelModeOf(look);
    for (const button of el.querySelectorAll<HTMLElement>('[data-label]')) {
      button.setAttribute('aria-checked', String(button.dataset.label === mode));
    }
    // The label text is for the printed labels only.
    const textField = el.querySelector<HTMLElement>('.rp-label-text-field');
    if (textField) textField.hidden = mode === 'image' || mode === 'none';
    // No finish chosen: the shell's own disc (the gold-disc shell's gold, otherwise the art print).
    const disc = look.discFinish ?? presetDisc[look.shell] ?? 'print';
    for (const button of el.querySelectorAll<HTMLElement>('[data-disc]')) {
      button.setAttribute('aria-checked', String(button.dataset.disc === disc));
    }
    // The plastic's colour: the preset's own, the cover's suggestion, or any colour (`shellTint`).
    const presetGel = resolvePreset(look.shell).gel;
    const tint = look.shellTint?.toLowerCase();
    const coverTint = suggestion?.tint?.toLowerCase();
    const tintChoice = !tint ? 'preset' : tint === coverTint ? 'cover' : null;
    const chip = (selector: string, colour: string) => {
      const element = el.querySelector<HTMLElement>(selector);
      element?.style.setProperty('--chip', colour);
      element?.style.setProperty('--chip2', colour);
    };
    chip('.rp-tint-preset-chip', presetGel);
    if (coverTint) chip('.rp-tint-cover-chip', coverTint);
    chip('.rp-tint-custom-chip', tint ?? presetGel);
    for (const button of el.querySelectorAll<HTMLElement>('[data-tint]')) {
      button.setAttribute('aria-checked', String(button.dataset.tint === tintChoice));
      if (button.dataset.tint === 'cover') button.hidden = !coverTint;
    }
    const customTint = el.querySelector<HTMLElement>('[data-tint-custom]');
    if (customTint) {
      customTint.setAttribute('aria-checked', String(tintChoice === null));
      const input = customTint.querySelector<HTMLInputElement>('.rp-tint-custom');
      if (input && document.activeElement !== input) input.value = /^#[0-9a-f]{6}$/.test(tint ?? presetGel) ? (tint ?? presetGel) : '#ffffff';
    }
    updateLookStatus();
    renderLabel();
    renderStickers();
  }

  /** Saves the local casing (look and stickers). True when it went through. */
  async function saveLook(): Promise<boolean> {
    if (!state || !look) return false;
    const status = $('.rp-look-status', section(3));
    // Keep whatever else the saved design carries (accents, theme); the server fills in the facts. Stickers are
    // the local `stickers`/`otherStickers` draft, not whatever the last save happened to carry.
    const kept: Record<string, unknown> = { ...(state.design ?? {}) };
    for (const fact of ['v', 'slug', 'title', 'artist', 'year', 'tracks', 'coverArt', 'discArt', 'labelImage', 'slideColor']) delete kept[fact];
    const all = allStickers();
    kept.stickers = all.length > 0 ? all : undefined;
    setStatus(status, 'Saving…');
    try {
      const result = await backend.saveDesign({ slug: state.slug, design: { ...kept, ...look } });
      lookDirty = false;
      if (result.changed) render = null;
      await refresh();
      setStatus($('.rp-look-status', section(3)), `Saved (revision ${result.designRev}).${result.changed ? ' Render the rack art and the bundle again.' : ''}`, 'ok');
      return true;
    } catch (error) {
      setStatus(status, errorText(error), 'error');
      return false;
    }
  }

  /** Uploads and removals change the saved design on the server: save local edits first so none are lost. */
  async function ensureSaved(): Promise<boolean> {
    if (state?.designHash && !lookDirty) return true;
    return await saveLook();
  }

  const rangeField = (className: string, field: PlaceField, label: string, value: number) => {
    const [min, max, step] = field === 'rotation' ? [-180, 180, 1] : field === 'size' ? [0.05, 1, 0.01] : [0, 1, 0.01];
    return `
      <label class="field">
        <span>${label} <span class="rp-sticker-readout">${readout(field, value)}</span></span>
        <input type="range" class="${className}" data-field="${field}" min="${min}" max="${max}" step="${step}" value="${value}">
      </label>`;
  };
  const placeFields = (className: string, place: { x: number; y: number; size: number; rotation?: number }) =>
    [
      rangeField(className, 'x', 'X', place.x),
      rangeField(className, 'y', 'Y', place.y),
      rangeField(className, 'size', 'Size', place.size),
      rangeField(className, 'rotation', 'Rotation', place.rotation ?? 0),
    ].join('');
  const imageTypes = /^image\/(png|jpeg|webp)$/;

  // ── The label layer: printed (paper or on the metal), an uploaded image placed like a sticker, or none ─────

  function pickLabel(mode: LabelMode) {
    if (!look || !state) return;
    if (mode === 'image') {
      if (look.labelImage) return;
      if (state.labelUrl) {
        labelPicking = false;
        changeLook({ labelImage: { ...LABEL_PLACE, ...(lastLabel ?? {}), src: state.labelUrl } });
        return;
      }
      // No label image yet: show the upload box (the choice sticks once one is uploaded).
      labelPicking = true;
      updateCasingControls();
      section(3).querySelector<HTMLElement>('.rp-label-drop')?.focus();
      return;
    }
    labelPicking = false;
    if (look.labelImage) lastLabel = look.labelImage;
    // The older styles carried the slide's colour; keep it as the slide colour when the label changes.
    const legacy = !look.slideColor && (look.labelStyle === 'metal-dark' || look.labelStyle === 'tinted');
    changeLook({ labelStyle: mode, labelImage: undefined, ...(legacy ? { slideColor: slideOf(look) } : {}) });
  }

  /** Delegated listeners on the stable `.rp-label-image` container, wired once; `renderLabel` replaces its content. */
  function wireLabel(el: HTMLElement) {
    const box = $('.rp-label-image', el);
    box.addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      if (!input.matches('.rp-label-file')) return;
      if (input.files?.[0]) void uploadLabel(input.files[0]);
      input.value = '';
    });
    box.addEventListener('input', (event) => {
      const input = event.target as HTMLInputElement;
      if (!input.matches('.rp-label-field') || !look?.labelImage) return;
      const field = input.dataset.field as PlaceField;
      const value = Number(input.value);
      look = { ...look, labelImage: { ...look.labelImage, [field]: value } };
      const out = input.closest('label')?.querySelector('.rp-sticker-readout');
      if (out) out.textContent = readout(field, value);
      lookDirty = true;
      updateLookStatus();
      showPreview();
    });
    box.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('.rp-label-remove')) void removeLabelImage();
      else if (target.closest('.rp-label-cancel')) {
        labelPicking = false;
        updateCasingControls();
      }
    });
    box.addEventListener('dragover', (event) => {
      if (!(event.target as HTMLElement).closest('.rp-drop')) return;
      event.preventDefault();
      (event.target as HTMLElement).closest('.rp-drop')!.classList.add('over');
    });
    box.addEventListener('dragleave', (event) => (event.target as HTMLElement).closest('.rp-drop')?.classList.remove('over'));
    box.addEventListener('drop', (event) => {
      if (!(event.target as HTMLElement).closest('.rp-drop')) return;
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (file) void uploadLabel(file);
    });
    box.addEventListener('keydown', (event) => {
      const zone = (event.target as HTMLElement).closest('.rp-drop');
      if (zone && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        zone.querySelector<HTMLInputElement>('input[type="file"]')?.click();
      }
    });
  }

  function renderLabel() {
    const box = section(3).querySelector<HTMLElement>('.rp-label-image');
    if (!box || !look) return;
    const status = `<progress class="rp-label-progress" max="1" value="0" hidden></progress><p class="admin-status rp-label-status" role="status" aria-live="polite"></p>`;
    const label = look.labelImage;
    if (label) {
      box.innerHTML = `
        <div class="rp-sticker rp-label-card">
          <div class="rp-sticker-thumb"><img src="${escapeHtml(label.src)}" alt="Label image"></div>
          <div class="rp-sticker-fields">${placeFields('rp-label-field', label)}</div>
          <div class="admin-actions rp-card-actions">
            <label class="secondary-btn mini-btn rp-file-btn">REPLACE<input type="file" accept="image/png,image/jpeg,image/webp" class="rp-label-file" hidden></label>
            <button type="button" class="secondary-btn mini-btn rp-label-remove">REMOVE</button>
          </div>
        </div>
        ${status}`;
      return;
    }
    if (labelPicking) {
      box.innerHTML = `
        <label class="rp-drop rp-label-drop" tabindex="0">
          <input type="file" accept="image/png,image/jpeg,image/webp" class="rp-label-file">
          <strong>CHOOSE A LABEL IMAGE</strong>
          <span>PNG (any shape, keeps its shape), JPEG or WebP. It sits on the slide, under the stickers; place it with the sliders or PLACE.</span>
        </label>
        <div class="admin-actions"><button type="button" class="secondary-btn mini-btn rp-label-cancel">CANCEL</button></div>
        ${status}`;
      return;
    }
    box.innerHTML = state?.labelUrl
      ? `<p class="admin-sub">A label image is uploaded; choose IMAGE to use it again.</p>${status}`
      : status;
  }

  async function uploadLabel(file: File) {
    if (!state) return;
    const status = () => $('.rp-label-status', section(3));
    if (!imageTypes.test(file.type)) return setStatus(status(), 'Use a PNG, JPEG or WebP image.', 'error');
    if (file.size > MAX_STICKER_BYTES) return setStatus(status(), `${mb(file.size)} is over the ${mb(MAX_STICKER_BYTES)} limit.`, 'error');
    setStatus(status(), 'Saving the casing…');
    if (!(await ensureSaved())) return setStatus(status(), 'Save the casing first (see the message below).', 'error');
    setStatus(status(), 'Uploading…');
    try {
      const id = await backend.upload(state.slug, file, file.type, (fraction) => {
        const current = section(3).querySelector<HTMLProgressElement>('.rp-label-progress');
        if (current) {
          current.hidden = false;
          current.value = fraction;
        }
      });
      setStatus(status(), 'Checking…');
      await backend.attachLabel({ slug: state.slug, file: id });
      labelPicking = false;
      await refresh();
      setStatus(status(), 'Label image added. Place it with the sliders or PLACE.', 'ok');
    } catch (error) {
      setStatus(status(), errorText(error), 'error');
    }
  }

  async function removeLabelImage() {
    if (!state) return;
    const status = () => $('.rp-label-status', section(3));
    setStatus(status(), 'Removing…');
    if (!(await ensureSaved())) return setStatus(status(), 'Save the casing first (see the message below).', 'error');
    try {
      await backend.removeLabel({ slug: state.slug });
      lastLabel = null;
      await refresh();
      setStatus(status(), 'Label image removed: the printed label shows again.', 'ok');
    } catch (error) {
      setStatus(status(), errorText(error), 'error');
    }
  }

  // ── The stickers layer: built-ins, emoji and uploads, on the slide cover or anywhere on the clear cover ───

  /** A drawn sticker's thumbnail (a data URL), drawn once; empty until the three.js module has loaded. */
  function thumbOf(ref: string): string {
    const cached = thumbs.get(ref);
    if (cached) return cached;
    if (!threeMod) return '';
    const url = threeMod.drawnSticker(ref, 160).toDataURL('image/png');
    thumbs.set(ref, url);
    return url;
  }

  const onShutterCount = () => stickers.filter((entry) => stickerFields(entry.sticker).area === 'shutter').length;
  const stickerTotal = () => otherStickers.length + stickers.length;

  /** Delegated listeners on the stable `.rp-stickers` container, wired once; `renderStickers` only replaces its content. */
  function wireStickers(el: HTMLElement) {
    const root = $('.rp-stickers', el);
    root.addEventListener('change', (event) => {
      const target = event.target as HTMLElement;
      if (target.matches('.rp-sticker-file')) {
        const input = target as HTMLInputElement;
        if (input.files?.[0]) void uploadSticker(input.files[0], addArea);
        input.value = '';
        return;
      }
      if (target.matches('.rp-sticker-add-area')) {
        addArea = (target as HTMLSelectElement).value as StickerFields['area'];
        return;
      }
      if (target.matches('.rp-sticker-field') && target.tagName === 'SELECT') {
        const card = target.closest<HTMLElement>('[data-i]');
        if (!card) return;
        const i = Number(card.dataset.i);
        const value = (target as HTMLSelectElement).value as StickerFields['area'];
        stickers[i] = { ...stickers[i], sticker: asSticker({ ...stickerFields(stickers[i].sticker), area: value }) };
        lookDirty = true;
        updateLookStatus();
        renderStickers();
        showPreview();
      }
    });
    root.addEventListener('input', (event) => {
      const input = event.target as HTMLElement;
      if (!input.matches('.rp-sticker-field') || input.tagName !== 'INPUT') return;
      const card = input.closest<HTMLElement>('[data-i]');
      if (!card) return;
      const i = Number(card.dataset.i);
      const field = (input as HTMLInputElement).dataset.field as PlaceField;
      const value = Number((input as HTMLInputElement).value);
      stickers[i] = { ...stickers[i], sticker: asSticker({ ...stickerFields(stickers[i].sticker), [field]: value }) };
      const out = input.closest('label')?.querySelector('.rp-sticker-readout');
      if (out) out.textContent = readout(field, value);
      lookDirty = true;
      updateLookStatus();
      showPreview();
    });
    root.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const tab = target.closest<HTMLElement>('[data-tab]');
      if (tab) {
        pickerTab = tab.dataset.tab as typeof pickerTab;
        renderStickers();
        root.querySelector<HTMLElement>(`[data-tab="${pickerTab}"]`)?.focus();
        return;
      }
      const add = target.closest<HTMLButtonElement>('[data-add]');
      if (add && !add.disabled) return addDrawn(add.dataset.add!);
      if (target.closest('.rp-emoji-add')) return addTypedEmoji();
      const remove = target.closest<HTMLElement>('.rp-sticker-remove');
      if (remove) void removeStickerCard(Number(remove.dataset.i));
    });
    root.addEventListener('keydown', (event) => {
      if ((event.target as HTMLElement).matches('.rp-emoji-input') && event.key === 'Enter') {
        event.preventDefault();
        addTypedEmoji();
      }
    });
    root.addEventListener('dragover', (event) => {
      if (!(event.target as HTMLElement).closest('.rp-drop')) return;
      event.preventDefault();
      (event.target as HTMLElement).closest('.rp-drop')!.classList.add('over');
    });
    root.addEventListener('dragleave', (event) => (event.target as HTMLElement).closest('.rp-drop')?.classList.remove('over'));
    root.addEventListener('drop', (event) => {
      if (!(event.target as HTMLElement).closest('.rp-drop')) return;
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (file) void uploadSticker(file, addArea);
    });
  }

  const stickerCard = (entry: { file: Id<'_storage'> | null; sticker: DiscSticker }, i: number) => {
    const f = stickerFields(entry.sticker);
    const drawn = isDrawnArt(f.src);
    const name = drawn ? drawnName(f.src) : `Sticker ${i + 1}`;
    const thumb = drawn ? thumbOf(f.src) : f.src;
    // The slide cover is full: only the ones already on it can stay there.
    const shutterFull = onShutterCount() >= MAX_SHUTTER_IMAGE_STICKERS && f.area !== 'shutter';
    return `<div class="rp-sticker" data-i="${i}">
      <div class="rp-sticker-thumb">${thumb ? `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(name)}" loading="lazy">` : `<span>${escapeHtml(name)}</span>`}</div>
      <div class="rp-sticker-fields">
        <label class="field"><span>Area</span>
          <select class="rp-sticker-field" data-field="area">
            <option value="shutter" ${f.area === 'shutter' ? 'selected' : ''} ${shutterFull ? 'disabled' : ''}>${AREA_NAMES.shutter}</option>
            <option value="shell" ${f.area === 'shell' ? 'selected' : ''}>${AREA_NAMES.shell}</option>
          </select>
        </label>
        ${placeFields('rp-sticker-field', f)}
      </div>
      <button type="button" class="secondary-btn mini-btn rp-sticker-remove" data-i="${i}" aria-label="Remove ${escapeHtml(name)}">REMOVE</button>
    </div>`;
  };

  /** Rebuilds the stickers panel's content (not `.rp-stickers` itself, so its delegated listeners stay wired). */
  function renderStickers() {
    const root = section(3).querySelector<HTMLElement>('.rp-stickers');
    if (!root || !state) return;
    const onShutter = onShutterCount();
    const atTotal = stickerTotal() >= MAX_IMAGE_STICKERS;
    const atShutter = onShutter >= MAX_SHUTTER_IMAGE_STICKERS;
    if (atShutter && addArea === 'shutter') addArea = 'shell';
    const off = atTotal ? 'disabled' : '';
    const tabs: [typeof pickerTab, string][] = [
      ['library', 'LIBRARY'],
      ['emoji', 'EMOJI'],
      ['upload', 'UPLOAD'],
    ];
    const panel =
      pickerTab === 'library'
        ? `<div class="rp-picker-grid">${STICKER_PRESETS.map((preset) => {
            const thumb = thumbOf(`preset:${preset.id}`);
            return `<button type="button" class="rp-pick" data-add="preset:${preset.id}" title="${escapeHtml(preset.title)}" ${off}>
              ${thumb ? `<img src="${thumb}" alt="">` : ''}<span>${escapeHtml(preset.title)}</span>
            </button>`;
          }).join('')}</div>`
        : pickerTab === 'emoji'
          ? `<div class="rp-picker-grid rp-emoji-grid">${STICKER_EMOJI.map(
              (emoji) => `<button type="button" class="rp-pick rp-pick-emoji" data-add="emoji:${emoji}" aria-label="Add ${emoji}" ${off}><span class="rp-emoji">${emoji}</span></button>`,
            ).join('')}</div>
            <div class="rp-emoji-own">
              <input class="rp-emoji-input" maxlength="16" placeholder="Paste any emoji" aria-label="Any emoji" ${off}>
              <button type="button" class="secondary-btn mini-btn rp-emoji-add" ${off}>ADD</button>
            </div>`
          : `<label class="rp-drop rp-sticker-drop" tabindex="0">
              <input type="file" accept="image/png,image/jpeg,image/webp" class="rp-sticker-file" ${off}>
              <strong>UPLOAD A STICKER OR LABEL</strong>
              <span>PNG (any shape, keeps its shape), JPEG or WebP, up to ${mb(MAX_STICKER_BYTES)}.</span>
            </label>`;
    root.innerHTML = `
      <p class="admin-sub">${stickerTotal()}/${MAX_IMAGE_STICKERS} STICKERS · ${onShutter}/${MAX_SHUTTER_IMAGE_STICKERS} ON THE SLIDE COVER</p>
      <div class="rp-picker">
        <div class="rp-picker-tabs" role="tablist" aria-label="Add a sticker">
          ${tabs.map(([id, label]) => `<button type="button" class="secondary-btn mini-btn" role="tab" data-tab="${id}" aria-selected="${pickerTab === id}">${label}</button>`).join('')}
        </div>
        <label class="field rp-picker-area"><span>Add to</span>
          <select class="rp-sticker-add-area" ${off}>
            <option value="shutter" ${addArea === 'shutter' ? 'selected' : ''} ${atShutter ? 'disabled' : ''}>${AREA_NAMES.shutter}</option>
            <option value="shell" ${addArea === 'shell' ? 'selected' : ''}>${AREA_NAMES.shell}</option>
          </select>
        </label>
        <div class="rp-picker-panel" role="tabpanel">${panel}</div>
        ${atTotal ? `<p class="admin-sub">At the ${MAX_IMAGE_STICKERS} sticker limit: remove one to add another.</p>` : ''}
      </div>
      <progress class="rp-sticker-progress" max="1" value="0" hidden></progress>
      <p class="admin-status rp-sticker-status" role="status" aria-live="polite"></p>
      <div class="rp-sticker-list">
        ${stickers.length ? stickers.map(stickerCard).join('') : '<p class="rp-empty">No stickers yet.</p>'}
      </div>`;
  }

  /** Room for one more on `area`, or the reason there isn't. */
  function stickerRoom(area: StickerFields['area']): string | null {
    if (stickerTotal() >= MAX_IMAGE_STICKERS) return `A release has at most ${MAX_IMAGE_STICKERS} stickers.`;
    if (area === 'shutter' && onShutterCount() >= MAX_SHUTTER_IMAGE_STICKERS) {
      return `The slide cover has at most ${MAX_SHUTTER_IMAGE_STICKERS} stickers. Add it to the clear cover instead.`;
    }
    return null;
  }

  /** A built-in or an emoji: added locally (no upload), saved with SAVE CASING like the rest of the look. */
  function addDrawn(ref: string) {
    const status = () => section(3).querySelector('.rp-sticker-status');
    const full = stickerRoom(addArea);
    if (full) return setStatus(status(), full, 'error');
    if (!isKnownDrawnArt(ref)) return setStatus(status(), 'That is not a single emoji.', 'error');
    stickers.push({ file: null, sticker: asSticker({ kind: 'image', src: ref, area: addArea, ...DRAWN_PLACE }) });
    lookDirty = true;
    updateLookStatus();
    renderStickers();
    setStatus(status(), `${drawnName(ref)} added to the ${AREA_NAMES[addArea].toLowerCase()}. Place it, then SAVE CASING.`, 'ok');
    showPreview();
  }

  function addTypedEmoji() {
    const input = section(3).querySelector<HTMLInputElement>('.rp-emoji-input');
    const emoji = firstGrapheme(input?.value ?? '');
    if (!emoji) return setStatus(section(3).querySelector('.rp-sticker-status'), 'Paste or type an emoji first.', 'error');
    addDrawn(`emoji:${emoji}`);
  }

  async function uploadSticker(file: File, area: StickerFields['area']) {
    if (!state) return;
    const status = () => $('.rp-sticker-status', section(3));
    if (!imageTypes.test(file.type)) return setStatus(status(), 'Use a PNG, JPEG or WebP image.', 'error');
    if (file.size > MAX_STICKER_BYTES) return setStatus(status(), `${mb(file.size)} is over the ${mb(MAX_STICKER_BYTES)} limit.`, 'error');
    const full = stickerRoom(area);
    if (full) return setStatus(status(), full, 'error');
    setStatus(status(), 'Saving the casing…');
    if (!(await ensureSaved())) return setStatus(status(), 'Save the casing first (see the message below).', 'error');
    setStatus(status(), 'Uploading…');
    try {
      const id = await backend.upload(state.slug, file, file.type, (fraction) => {
        const bar = section(3).querySelector<HTMLProgressElement>('.rp-sticker-progress');
        if (bar) {
          bar.hidden = false;
          bar.value = fraction;
        }
      });
      setStatus(status(), 'Checking…');
      await backend.attachSticker({ slug: state.slug, file: id, area });
      await refresh();
      setStatus(status(), 'Sticker added. Place it with the sliders or PLACE.', 'ok');
    } catch (error) {
      setStatus(status(), errorText(error), 'error');
    }
  }

  /** An upload goes on the server (file and design entry); a built-in or emoji only leaves the local list. */
  async function removeStickerCard(i: number) {
    const entry = stickers[i];
    if (!state || !entry) return;
    const status = () => $('.rp-sticker-status', section(3));
    if (!entry.file) {
      stickers.splice(i, 1);
      lookDirty = true;
      updateLookStatus();
      renderStickers();
      showPreview();
      return setStatus(status(), 'Sticker removed. SAVE CASING to keep the change.', 'ok');
    }
    setStatus(status(), 'Removing…');
    if (!(await ensureSaved())) return setStatus(status(), 'Save the casing first (see the message below).', 'error');
    try {
      await backend.removeSticker({ slug: state.slug, file: entry.file });
      await refresh();
      setStatus(status(), 'Sticker removed.', 'ok');
    } catch (error) {
      setStatus(status(), errorText(error), 'error');
    }
  }

  // ── 5. Render ─────────────────────────────────────────────────────────────────────────────────────────
  function stopSprite() {
    if (spriteTimer) cancelAnimationFrame(spriteTimer);
    spriteTimer = 0;
  }

  /** Plays the optional spin loop's sprite sheet in a canvas at its fps. */
  function playSprite(canvas: HTMLCanvasElement, src: string, meta: { frames: number; cols: number; frameW: number; frameH: number; fps: number }) {
    stopSprite();
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = src;
    const ctx = canvas.getContext('2d')!;
    const start = performance.now();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const tick = (now: number) => {
      spriteTimer = requestAnimationFrame(tick);
      if (!image.complete || !image.naturalWidth || !canvas.isConnected) return;
      const frame = reduce ? 0 : Math.floor(((now - start) / 1000) * meta.fps) % meta.frames;
      const x = (frame % meta.cols) * meta.frameW;
      const y = Math.floor(frame / meta.cols) * meta.frameH;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, x, y, meta.frameW, meta.frameH, 0, 0, canvas.width, canvas.height);
    };
    spriteTimer = requestAnimationFrame(tick);
  }

  let renderUrls: { still: string; sprite: string | null } | null = null;

  function renderRender() {
    const el = section(4);
    const s = state!;
    if (!s.designHash || !s.design) {
      el.innerHTML = '<p class="admin-sub">Save the casing first (step 4).</p>';
      return;
    }
    const existing = s.rack;
    const loopShown = Boolean(render?.loop) || (!render && Boolean(existing?.spriteUrl && existing.spriteMeta));
    el.innerHTML = `
      <p class="admin-sub">The rack grid shows one still: the release in its printed sleeve, the disc all the way inside, a detailed render of the card at a slight angle. It is rendered here, in this browser, from the saved casing, and uploaded as PNG and WebP. The spin loop is optional; the app no longer plays it.</p>
      <label class="admin-sub rp-loop-choice"><input type="checkbox" class="rp-with-loop" ${withLoop ? 'checked' : ''}> Also render the spin loop (optional)</label>
      <div class="admin-actions">
        <button type="button" class="primary-btn rp-do-render">${render ? 'RENDER AGAIN' : 'RENDER SLEEVE STILL'}</button>
        <button type="button" class="primary-btn rp-upload-render" ${render ? '' : 'disabled'}>UPLOAD RACK ART</button>
      </div>
      <progress class="rp-render-progress" max="1" value="0" hidden></progress>
      <p class="admin-status rp-render-status" role="status" aria-live="polite"></p>
      <div class="rp-render-grid">
        <figure><img class="rp-still" alt="The sleeve still the rack shows" hidden><figcaption class="admin-sub rp-still-caption"></figcaption></figure>
        ${loopShown ? '<figure><canvas class="rp-sprite" width="256" height="256" aria-label="Spin loop preview"></canvas><figcaption class="admin-sub">SPIN LOOP · OPTIONAL</figcaption></figure>' : ''}
      </div>`;
    const status = $('.rp-render-status', el);
    const still = $<HTMLImageElement>('.rp-still', el);
    const caption = $('.rp-still-caption', el);
    const canvas = el.querySelector<HTMLCanvasElement>('.rp-sprite');
    $<HTMLInputElement>('.rp-with-loop', el).addEventListener('change', (event) => {
      withLoop = (event.currentTarget as HTMLInputElement).checked;
    });
    if (render && renderUrls) {
      still.src = renderUrls.still;
      still.hidden = false;
      if (canvas && render.loop && renderUrls.sprite) playSprite(canvas, renderUrls.sprite, render.loop.sheet.meta);
      caption.textContent = `NEW · ${render.still.size} PX · ${render.still.webp ? 'PNG + WEBP' : 'PNG'}${render.loop ? ' · WITH LOOP' : ''} · NOT UPLOADED`;
    } else if (existing?.stillUrl) {
      still.src = existing.stillUrl;
      still.hidden = false;
      if (canvas && existing.spriteUrl && existing.spriteMeta) playSprite(canvas, existing.spriteUrl, existing.spriteMeta);
      caption.textContent = existing.fresh ? 'UPLOADED · UP TO DATE' : 'UPLOADED · OUT OF DATE: RENDER AGAIN';
    } else caption.textContent = 'NOT RENDERED YET';

    $('.rp-do-render', el).addEventListener('click', async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      setStatus(status, 'Loading the renderer…');
      try {
        const mod = await loadThree();
        const design = { ...(state!.design as DiscDesign), coverArt: coverSrc()! };
        const loaded = await artFor(design);
        const started = performance.now();
        setStatus(status, 'Rendering the sleeve still…');
        const sleeve = await mod.renderSleeveStill(design, { art: loaded });
        let loop: SpinLoopResult | null = null;
        if (withLoop) {
          setStatus(status, 'Rendering 36 frames of the spin loop…');
          loop = await mod.renderSpinLoop(design, { art: loaded });
        }
        render = { still: sleeve, loop };
        if (renderUrls) {
          URL.revokeObjectURL(renderUrls.still);
          if (renderUrls.sprite) URL.revokeObjectURL(renderUrls.sprite);
        }
        renderUrls = { still: URL.createObjectURL(sleeve.png), sprite: loop ? URL.createObjectURL(loop.sheet.webp ?? loop.sheet.png) : null };
        renderRender();
        const size = sleeve.png.size + (sleeve.webp?.size ?? 0) + (loop ? (loop.sheet.webp?.size ?? 0) + loop.sheet.png.size : 0);
        setStatus($('.rp-render-status', section(4)), `Rendered in ${((performance.now() - started) / 1000).toFixed(1)} s (${mb(size)}). Check it, then upload.`, 'ok');
      } catch (error) {
        button.disabled = false;
        setStatus(status, errorText(error, 'The render failed.'), 'error');
      }
    });
    $('.rp-upload-render', el).addEventListener('click', async (event) => {
      if (!render || !state?.designHash) return;
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      const bar = $<HTMLProgressElement>('.rp-render-progress', el);
      bar.hidden = false;
      const slug = state.slug;
      const { still: sleeve, loop } = render;
      type Part = { key: 'still' | 'stillWebp' | 'spriteWebp' | 'spritePng'; blob: Blob; type: string };
      const parts: Part[] = [
        { key: 'still', blob: sleeve.png, type: 'image/png' },
        ...(sleeve.webp ? [{ key: 'stillWebp', blob: sleeve.webp, type: 'image/webp' } as Part] : []),
        ...(loop?.sheet.webp ? [{ key: 'spriteWebp', blob: loop.sheet.webp, type: 'image/webp' } as Part] : []),
        ...(loop ? [{ key: 'spritePng', blob: loop.sheet.png, type: 'image/png' } as Part] : []),
      ];
      const total = parts.reduce((sum, part) => sum + part.blob.size, 0);
      let done = 0;
      try {
        const ids: Partial<Record<Part['key'], Id<'_storage'>>> = {};
        for (const [i, part] of parts.entries()) {
          setStatus(status, `Uploading ${i + 1} of ${parts.length}…`);
          ids[part.key] = await backend.upload(slug, part.blob, part.type, (fraction) => (bar.value = (done + fraction * part.blob.size) / total));
          done += part.blob.size;
        }
        setStatus(status, 'Checking…');
        await backend.attachRackArt({
          slug,
          still: ids.still!,
          stillWebp: ids.stillWebp,
          spriteWebp: ids.spriteWebp,
          spritePng: ids.spritePng,
          spriteMeta: loop?.sheet.meta,
          designHash: state.designHash,
        });
        render = null;
        await refresh();
        setStatus($('.rp-render-status', section(4)), 'Rack art uploaded.', 'ok');
      } catch (error) {
        button.disabled = false;
        setStatus(status, errorText(error, 'The upload failed.'), 'error');
      }
    });
  }

  // ── 6. Bundle ─────────────────────────────────────────────────────────────────────────────────────────
  function cliSteps(slug: string) {
    return `
      <ol class="rp-cli">
        <li>In the repo, on Node 22: <code>export PATH="/opt/homebrew/opt/node@22/bin:$PATH"</code></li>
        <li>Build and upload: <code>npm run publish:release -- --slug ${escapeHtml(slug)} --as you@myindsound.com</code> (add <code>--prod</code> for production).</li>
        <li>It pulls the saved casing from Convex, builds the zip with <code>scripts/build-bundle.mjs</code>, uploads it and attaches it here.</li>
        <li>Come back to this step: it shows the bundle once it is attached.</li>
      </ol>`;
  }

  function renderBundle() {
    const el = section(5);
    const s = state!;
    if (!s.designHash || !s.design) {
      el.innerHTML = '<p class="admin-sub">Save the casing first (step 4).</p>';
      return;
    }
    const b = s.bundle;
    el.innerHTML = `
      <p class="admin-sub">The app downloads this zip and checks its SHA-256 (BUN-2): the generic release bundle, this release's design.json and its cover. It is built here, in this browser.</p>
      ${
        b
          ? `<dl class="readout">
              <div><dt>Version</dt><dd>${escapeHtml(b.version)}</dd></div>
              <div><dt>State</dt><dd>${b.fresh ? 'UP TO DATE' : 'OUT OF DATE: BUILD AGAIN'}</dd></div>
              <div class="rp-wide"><dt>SHA-256</dt><dd>${escapeHtml(b.sha256)}</dd></div>
            </dl>`
          : ''
      }
      <div class="admin-actions"><button type="button" class="primary-btn rp-build">${b ? 'BUILD AND UPLOAD AGAIN' : 'BUILD AND UPLOAD BUNDLE'}</button></div>
      <progress class="rp-bundle-progress" max="1" value="0" hidden></progress>
      <p class="admin-status rp-bundle-status" role="status" aria-live="polite"></p>
      <div class="rp-cli-box" hidden><p class="admin-sub">THE GENERIC BUNDLE ISN'T ON THIS SITE. BUILD IT FROM THE COMMAND LINE:</p>${cliSteps(s.slug)}</div>
      <details class="rp-details"><summary class="admin-sub">OR BUILD IT FROM THE COMMAND LINE</summary>${cliSteps(s.slug)}</details>`;
    $('.rp-build', el).addEventListener('click', (event) => void buildBundle(event.currentTarget as HTMLButtonElement));
  }

  async function coverBytes(): Promise<Uint8Array> {
    if (localCover) return new Uint8Array(await localCover.file.arrayBuffer());
    const response = await fetch(state!.coverUrl!);
    if (!response.ok) throw new Error(`The cover could not be downloaded (HTTP ${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Every uploaded image sticker's bytes the design names, keyed by its `src` (the uploaded URL), for `assembleReleaseZip`. */
  async function stickerBytesMap(design: DiscDesign): Promise<Map<string, Uint8Array>> {
    const srcs = ((design.stickers ?? []) as DiscSticker[])
      .map(stickerFields)
      .filter((sticker) => sticker.kind === 'image' && !isDrawnArt(sticker.src))
      .map((sticker) => sticker.src);
    const map = new Map<string, Uint8Array>();
    await Promise.all(
      srcs.map(async (src) => {
        if (map.has(src)) return;
        const response = await fetch(src);
        if (!response.ok) throw new Error(`A sticker image could not be downloaded (HTTP ${response.status}).`);
        map.set(src, new Uint8Array(await response.arrayBuffer()));
      }),
    );
    return map;
  }

  /** The label image's bytes, when the design has an uploaded one. */
  async function labelBytes(design: DiscDesign): Promise<Uint8Array | undefined> {
    const src = design.labelImage?.src;
    if (!src || isDrawnArt(src)) return undefined;
    const response = await fetch(src);
    if (!response.ok) throw new Error(`The label image could not be downloaded (HTTP ${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function buildBundle(button: HTMLButtonElement) {
    const s = state;
    if (!s?.design || !s.designHash) return;
    const el = section(5);
    const status = $('.rp-bundle-status', el);
    const bar = $<HTMLProgressElement>('.rp-bundle-progress', el);
    button.disabled = true;
    setStatus(status, 'Fetching the generic bundle…');
    try {
      const response = await fetch(`${GENERIC_BUNDLE}index.json`, { cache: 'no-cache' });
      if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) {
        $<HTMLElement>('.rp-cli-box', el).hidden = false;
        $<HTMLElement>('.rp-details', el).hidden = true;
        throw new Error('The generic bundle is not deployed with this site. Use the command line below.');
      }
      const index = (await response.json()) as GenericBundleIndex;
      const files = new Map<string, Uint8Array>();
      bar.hidden = false;
      let fetched = 0;
      await Promise.all(
        index.files.map(async ({ path }) => {
          const file = await fetch(`${GENERIC_BUNDLE}files/${path.split('/').map(encodeURIComponent).join('/')}`);
          if (!file.ok) throw new Error(`Generic bundle file missing: ${path} (HTTP ${file.status}).`);
          files.set(path, new Uint8Array(await file.arrayBuffer()));
          bar.value = (++fetched / index.files.length) * 0.4;
        }),
      );
      setStatus(status, 'Zipping…');
      const version = `${index.version}+r${s.designRev}`;
      const zipDesign = s.design as DiscDesign;
      const { zip, sha256 } = await assembleReleaseZip({
        index,
        files,
        design: zipDesign,
        cover: await coverBytes(),
        stickers: await stickerBytesMap(zipDesign),
        label: await labelBytes(zipDesign),
        releaseId: s.releaseId,
        version,
      });
      setStatus(status, `Uploading ${mb(zip.length)}…`);
      const blob = new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
      const id = await backend.upload(s.slug, blob, 'application/zip', (fraction) => (bar.value = 0.4 + fraction * 0.6));
      setStatus(status, 'Checking…');
      const result = await backend.attachBundle({ slug: s.slug, version, zip: id, sha256, designHash: s.designHash });
      await refresh();
      setStatus($('.rp-bundle-status', section(5)), `Bundle ${result.version} uploaded (${mb(zip.length)}).`, 'ok');
    } catch (error) {
      button.disabled = false;
      bar.hidden = true;
      setStatus(status, errorText(error, 'The bundle build failed.'), 'error');
    }
  }

  // ── 7. Publish ────────────────────────────────────────────────────────────────────────────────────────
  function renderPublish() {
    const el = section(6);
    const s = state!;
    if (s.status !== 'draft') {
      el.innerHTML = `<p class="admin-status ok">Published: ${escapeHtml(s.status)}${s.dropAt ? `, drop ${escapeHtml(new Date(s.dropAt).toLocaleString())}` : ''}. Change it from RELEASE settings.</p>`;
      return;
    }
    const problems = s.problems;
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    tomorrow.setMinutes(0, 0, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T${pad(tomorrow.getHours())}:00`;
    el.innerHTML = `
      ${
        problems.length
          ? `<p class="admin-sub">NOT READY YET</p><ul class="mono-list rp-problems">${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`
          : '<p class="admin-status ok">Ready: tracks, cover, casing, rack art and bundle are all up to date.</p>'
      }
      <form class="admin-form rp-publish-form" novalidate>
        <fieldset class="field rp-when">
          <span>When</span>
          <label><input type="radio" name="when" value="scheduled" checked> Schedule a drop</label>
          <label><input type="radio" name="when" value="live"> Live now</label>
        </fieldset>
        <label class="field"><span>Drop at (${escapeHtml(zoneLabel(tomorrow))})</span><input type="datetime-local" name="dropAt" value="${local}" step="60"></label>
        <p class="admin-sub rp-utc wide"></p>
        <label class="field wide"><span>Reason (required)</span><textarea name="reason" maxlength="500" required></textarea></label>
        <div class="admin-actions"><button class="primary-btn" type="submit" ${problems.length ? 'disabled' : ''}>REVIEW PUBLISH</button></div>
        <div class="confirm-strip" hidden></div>
        <p class="admin-status rp-publish-status" role="status" aria-live="polite"></p>
      </form>`;
    const form = $<HTMLFormElement>('form', el);
    const value = (name: string) => ((form.elements.namedItem(name) as HTMLInputElement | RadioNodeList | null)?.value ?? '').trim();
    const dropInput = form.elements.namedItem('dropAt') as HTMLInputElement;
    const utc = $('.rp-utc', el);
    const strip = $<HTMLElement>('.confirm-strip', form);
    const status = $('.rp-publish-status', form);
    const update = () => {
      strip.hidden = true;
      const live = value('when') === 'live';
      dropInput.disabled = live;
      if (live) {
        utc.textContent = 'Goes live the moment you confirm.';
        return;
      }
      const ms = new Date(dropInput.value).getTime();
      utc.textContent = Number.isFinite(ms) ? `Stored as UTC: ${new Date(ms).toISOString()} (${ms} ms)` : 'Pick a date and time.';
    };
    form.addEventListener('input', update);
    update();
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const reason = value('reason');
      const live = value('when') === 'live';
      const dropAt = live ? undefined : new Date(dropInput.value).getTime();
      if (!reason) return setStatus(status, 'A reason is required.', 'error');
      if (!live && (!Number.isFinite(dropAt) || dropAt! <= Date.now())) return setStatus(status, 'Pick a drop time in the future.', 'error');
      const lines = [
        `Release: ${s.title} (${s.slug}), ${s.tracks.length} track${s.tracks.length === 1 ? '' : 's'}`,
        live ? 'Status: live now' : `Status: scheduled for ${new Date(dropAt!).toLocaleString()} (${new Date(dropAt!).toISOString()})`,
        `Bundle: ${s.bundle?.version ?? '—'}`,
        `Reason: ${reason}`,
      ];
      strip.innerHTML = `
        <strong class="admin-sub">Publish this release? It appears in the app${live ? ' now' : ' as upcoming, with a countdown'}.</strong>
        <ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
        <div class="admin-actions">
          <button type="button" class="primary-btn" data-confirm>CONFIRM PUBLISH</button>
          <button type="button" class="secondary-btn" data-cancel>CANCEL</button>
        </div>`;
      strip.hidden = false;
      setStatus(status, '');
      const confirm = $<HTMLButtonElement>('[data-confirm]', strip);
      confirm.focus();
      $('[data-cancel]', strip).addEventListener('click', () => {
        strip.hidden = true;
        setStatus(status, 'Cancelled. Nothing was changed.');
      });
      confirm.addEventListener('click', async () => {
        confirm.disabled = true;
        try {
          const result = await backend.publish({ slug: s.slug, status: live ? 'live' : 'scheduled', ...(live ? {} : { dropAt }), reason });
          await refresh();
          void loadDrafts();
          setStatus($('.admin-status', section(6)), `Published: ${result.status}, drop ${new Date(result.dropAt).toLocaleString()}.`, 'ok');
        } catch (error) {
          confirm.disabled = false;
          setStatus(status, errorText(error), 'error');
        }
      });
    });
  }

  void loadDrafts();
}
