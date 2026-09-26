/**
 * The release portal: the RELEASES tab on /admin (Grilled.md "Release portal + generated discs", PRD §17 ADM-7).
 * A guided flow for one draft: 1 new release, 2 MP3s, 3 cover, 4 casing (live 3D), 5 spin render, 6 bundle,
 * 7 drop date and publish. Loaded by admin.ts only when the tab opens; three.js and packages/minidisc load later
 * still, at the casing step (`admin-releases-3d.ts`). Every change goes through convex/releases.ts, admin only
 * and audited. No window.confirm or alert: publishing is confirmed in the page, with a reason.
 */
import './admin-releases.css';
import type { Id } from '../convex/_generated/dataModel';
import type { DiscDesign, LoadedArt, ShellSuggestion, SpinLoopResult } from './admin-releases-3d';
import type { DraftRow, PortalBackend, ReleaseState } from './admin-releases-backend';
import { assembleReleaseZip, type GenericBundleIndex } from './admin-releases-zip';
import { convexErrorMessage } from './convex';

type ThreeModule = typeof import('./admin-releases-3d');

const STEPS = ['NEW', 'AUDIO', 'COVER', 'CASING', 'RENDER', 'BUNDLE', 'PUBLISH'] as const;
const MAX_MP3_BYTES = 80 * 1024 * 1024;
const MAX_COVER_BYTES = 25 * 1024 * 1024;
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

type Look = Pick<DiscDesign, 'shell' | 'shellTint' | 'labelStyle' | 'labelText'>;
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
  let art: { src: string; loaded: LoadedArt } | null = null;
  let look: Look | null = null;
  let lookDirty = false;
  let suggestion: ShellSuggestion | null = null;
  let sleeveOn = false;
  let preview: ReturnType<ThreeModule['createCasingPreview']> | null = null;
  let render: SpinLoopResult | null = null;
  let spriteTimer = 0;

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
    step = atStep ?? firstOpenStep();
    renderAll();
    wizard.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  async function refresh() {
    if (!state) return;
    state = await backend.get(state.slug);
    if (!tracksDirty) syncTracks();
    renderAll();
    void loadDrafts();
  }

  function syncTracks() {
    tracks = (state?.tracks ?? []).map((t) => ({ id: t.id, title: t.title, durationSeconds: t.durationSeconds, hasAudio: t.hasAudio, removed: false }));
    tracksDirty = false;
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
      shell: current.shell,
      shellTint: current.shellTint,
      labelStyle: current.labelStyle,
      labelText: current.labelText,
    };
  }

  async function ensureArt(mod: ThreeModule): Promise<LoadedArt> {
    const src = coverSrc();
    if (!src) throw new Error('Upload the cover first.');
    if (art?.src === src) return art.loaded;
    await mod.ready();
    const loaded = await mod.loadDesignArt(designWith({ shell: 'clear', labelStyle: 'none' }, src));
    art = { src, loaded };
    return loaded;
  }

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
            <canvas class="rp-canvas" tabindex="0" aria-label="Live 3D preview of the MiniDisc. Drag or use the arrow keys to turn it; double-click to reset."></canvas>
            <p class="rp-stage-note admin-sub">LOADING 3D…</p>
            <div class="admin-actions rp-stage-tools">
              <button type="button" class="secondary-btn mini-btn rp-sleeve" aria-pressed="false">SHOW SLEEVE</button>
              <button type="button" class="secondary-btn mini-btn rp-reset">FACE FRONT</button>
            </div>
          </div>
          <div class="rp-controls">
            <p class="admin-sub">SHELL</p>
            <div class="rp-swatches" role="radiogroup" aria-label="Shell"></div>
            <p class="rp-tint"></p>
            <p class="admin-sub">LABEL</p>
            <div class="rp-labels" role="radiogroup" aria-label="Label style">
              ${(['metal', 'sticker', 'none'] as const)
                .map((style) => `<button type="button" class="secondary-btn mini-btn" role="radio" data-label="${style}">${style.toUpperCase()}</button>`)
                .join('')}
            </div>
            <label class="field"><span>Label text (optional, one line each)</span><textarea class="rp-label-text" maxlength="160" rows="3" placeholder="${escapeHtml(`${s.title}\n${s.artist ?? ''}`)}"></textarea></label>
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
      loaded = await ensureArt(mod);
    } catch (error) {
      note.textContent = errorText(error, 'The 3D preview could not start.');
      return;
    }
    if (!el.isConnected || !state) return;
    suggestion ??= mod.suggestShell(loaded.cover);
    const saved = state.design;
    look ??= saved
      ? { shell: saved.shell, shellTint: saved.shellTint, labelStyle: saved.labelStyle, labelText: saved.labelText }
      : { shell: suggestion.shell, shellTint: suggestion.tint, labelStyle: 'sticker', labelText: undefined };
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
      // The suggested tint belongs to the suggested shell; another shell starts plain.
      changeLook({ shell, shellTint: shell === suggestion?.shell ? suggestion?.tint : undefined });
    });
    $('.rp-labels', el).addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-label]');
      if (button) changeLook({ labelStyle: button.dataset.label as Look['labelStyle'] });
    });
    let typing = 0;
    $<HTMLTextAreaElement>('.rp-label-text', el).addEventListener('input', (event) => {
      const value = (event.target as HTMLTextAreaElement).value;
      window.clearTimeout(typing);
      typing = window.setTimeout(() => changeLook({ labelText: value.trim() ? value : undefined }), 350);
    });
    $('.rp-save-look', el).addEventListener('click', () => void saveLook());
    $('.rp-sleeve', el).addEventListener('click', (event) => {
      sleeveOn = !sleeveOn;
      (event.currentTarget as HTMLElement).setAttribute('aria-pressed', String(sleeveOn));
      (event.currentTarget as HTMLElement).textContent = sleeveOn ? 'HIDE SLEEVE' : 'SHOW SLEEVE';
      preview?.setSleeve(sleeveOn);
    });
    $('.rp-reset', el).addEventListener('click', () => preview?.reset());
    const sleeveButton = $('.rp-sleeve', el);
    sleeveButton.setAttribute('aria-pressed', String(sleeveOn));
    sleeveButton.textContent = sleeveOn ? 'HIDE SLEEVE' : 'SHOW SLEEVE';
    try {
      preview = mod.createCasingPreview($<HTMLCanvasElement>('.rp-canvas', el));
      preview.setSleeve(sleeveOn);
      note.textContent = 'DRAG TO TURN · DOUBLE-CLICK TO RESET';
    } catch (error) {
      note.textContent = errorText(error, 'WebGL is not available in this browser.');
    }
    $<HTMLTextAreaElement>('.rp-label-text', el).value = look.labelText ?? '';
    updateCasingControls();
    showPreview();
  }

  function changeLook(patch: Partial<Look>) {
    if (!look) return;
    look = { ...look, ...patch };
    lookDirty = true;
    updateCasingControls();
    showPreview();
  }

  function showPreview() {
    const src = coverSrc();
    if (!preview || !look || !art || !src) return;
    try {
      preview.show(designWith(look, src), art.loaded);
    } catch (error) {
      setStatus($('.rp-look-status', section(3)), errorText(error, 'The preview failed.'), 'error');
    }
  }

  function updateCasingControls() {
    const el = section(3);
    if (!look) return;
    for (const button of el.querySelectorAll<HTMLElement>('[data-shell]')) {
      const on = button.dataset.shell === look.shell;
      button.setAttribute('aria-checked', String(on));
      button.classList.toggle('on', on);
    }
    for (const button of el.querySelectorAll<HTMLElement>('[data-label]')) {
      button.setAttribute('aria-checked', String(button.dataset.label === look.labelStyle));
    }
    const tint = $('.rp-tint', el);
    if (tint) {
      tint.innerHTML = look.shellTint
        ? `<span class="rp-chip small" style="--chip:${escapeHtml(look.shellTint)};--chip2:${escapeHtml(look.shellTint)}"></span> Tinted ${escapeHtml(look.shellTint)} from the cover. <button type="button" class="secondary-btn mini-btn rp-untint">PLAIN</button>`
        : suggestion?.tint && look.shell === suggestion.shell
          ? `The cover suggests a ${escapeHtml(suggestion.tint)} tint. <button type="button" class="secondary-btn mini-btn rp-retint">USE TINT</button>`
          : '';
      tint.querySelector('.rp-untint')?.addEventListener('click', () => changeLook({ shellTint: undefined }));
      tint.querySelector('.rp-retint')?.addEventListener('click', () => changeLook({ shellTint: suggestion?.tint }));
    }
    const status = $('.rp-look-status', el);
    if (status && !status.classList.contains('error')) {
      const saved = state?.designHash ? `Saved (revision ${state.designRev}).` : 'Not saved yet.';
      setStatus(status, lookDirty ? `Unsaved changes. ${saved}` : saved, lookDirty ? 'warn' : state?.designHash ? 'ok' : '');
    }
  }

  async function saveLook() {
    if (!state || !look) return;
    const status = $('.rp-look-status', section(3));
    // Keep whatever else the saved design carries (accents, stickers, theme); the server fills in the facts.
    const kept: Record<string, unknown> = { ...(state.design ?? {}) };
    for (const fact of ['v', 'slug', 'title', 'artist', 'year', 'tracks', 'coverArt', 'discArt']) delete kept[fact];
    setStatus(status, 'Saving…');
    try {
      const result = await backend.saveDesign({ slug: state.slug, design: { ...kept, ...look } });
      lookDirty = false;
      if (result.changed) render = null;
      await refresh();
      setStatus($('.rp-look-status', section(3)), `Saved (revision ${result.designRev}).${result.changed ? ' Render the rack art and the bundle again.' : ''}`, 'ok');
    } catch (error) {
      setStatus(status, errorText(error), 'error');
    }
  }

  // ── 5. Render ─────────────────────────────────────────────────────────────────────────────────────────
  function stopSprite() {
    if (spriteTimer) cancelAnimationFrame(spriteTimer);
    spriteTimer = 0;
  }

  /** Plays a sprite sheet in a canvas at its fps, the way the app's rack grid will. */
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

  let renderUrls: { sprite: string; still: string } | null = null;

  function renderRender() {
    const el = section(4);
    const s = state!;
    if (!s.designHash || !s.design) {
      el.innerHTML = '<p class="admin-sub">Save the casing first (step 4).</p>';
      return;
    }
    const existing = s.rack;
    el.innerHTML = `
      <p class="admin-sub">The rack grid plays a pre-rendered loop: the release in its sleeve, the disc spinning one turn. It is rendered here, in this browser, from the saved casing.</p>
      <div class="admin-actions">
        <button type="button" class="primary-btn rp-do-render">${render ? 'RENDER AGAIN' : 'RENDER SPIN LOOP'}</button>
        <button type="button" class="primary-btn rp-upload-render" ${render ? '' : 'disabled'}>UPLOAD RACK ART</button>
      </div>
      <progress class="rp-render-progress" max="1" value="0" hidden></progress>
      <p class="admin-status rp-render-status" role="status" aria-live="polite"></p>
      <div class="rp-render-grid">
        <figure><canvas class="rp-sprite" width="256" height="256" aria-label="Spin loop preview"></canvas><figcaption class="admin-sub rp-sprite-caption"></figcaption></figure>
        <figure><img class="rp-still" alt="Still of the sleeved release" hidden><figcaption class="admin-sub">STILL</figcaption></figure>
      </div>`;
    const status = $('.rp-render-status', el);
    const canvas = $<HTMLCanvasElement>('.rp-sprite', el);
    const still = $<HTMLImageElement>('.rp-still', el);
    const caption = $('.rp-sprite-caption', el);
    if (render && renderUrls) {
      playSprite(canvas, renderUrls.sprite, render.sheet.meta);
      still.src = renderUrls.still;
      still.hidden = false;
      caption.textContent = `NEW · ${render.sheet.meta.frames} FRAMES · ${render.sheet.webp ? 'WEBP + PNG' : 'PNG'} · NOT UPLOADED`;
    } else if (existing?.spriteUrl && existing.stillUrl) {
      playSprite(canvas, existing.spriteUrl, existing.spriteMeta);
      still.src = existing.stillUrl;
      still.hidden = false;
      caption.textContent = existing.fresh ? 'UPLOADED · UP TO DATE' : 'UPLOADED · OUT OF DATE: RENDER AGAIN';
    } else caption.textContent = 'NOT RENDERED YET';

    $('.rp-do-render', el).addEventListener('click', async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      setStatus(status, 'Loading the renderer…');
      try {
        const mod = await loadThree();
        const loaded = await ensureArt(mod);
        setStatus(status, 'Rendering 36 frames…');
        const started = performance.now();
        const design = { ...(state!.design as DiscDesign), coverArt: art!.src };
        render = await mod.renderSpinLoop(design, { art: loaded });
        if (renderUrls) {
          URL.revokeObjectURL(renderUrls.sprite);
          URL.revokeObjectURL(renderUrls.still);
        }
        renderUrls = { sprite: URL.createObjectURL(render.sheet.webp ?? render.sheet.png), still: URL.createObjectURL(render.still) };
        renderRender();
        const size = (render.sheet.webp?.size ?? 0) + render.sheet.png.size + render.still.size;
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
      const parts: [Blob, string][] = [...(render.sheet.webp ? [[render.sheet.webp, 'image/webp'] as [Blob, string]] : []), [render.sheet.png, 'image/png'], [render.still, 'image/png']];
      const total = parts.reduce((sum, [blob]) => sum + blob.size, 0);
      let done = 0;
      try {
        const ids: Id<'_storage'>[] = [];
        for (const [blob, type] of parts) {
          setStatus(status, `Uploading ${ids.length + 1} of ${parts.length}…`);
          ids.push(await backend.upload(slug, blob, type, (fraction) => (bar.value = (done + fraction * blob.size) / total)));
          done += blob.size;
        }
        const [spriteWebp, spritePng, stillId] = render.sheet.webp ? ids : [undefined, ids[0], ids[1]];
        setStatus(status, 'Checking…');
        await backend.attachRackArt({ slug, spriteWebp, spritePng: spritePng!, spriteMeta: render.sheet.meta, still: stillId!, designHash: state.designHash });
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
      const { zip, sha256 } = await assembleReleaseZip({ index, files, design: s.design as DiscDesign, cover: await coverBytes(), releaseId: s.releaseId, version });
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
