/**
 * Admin dashboard: play and purchase stats, plus the admin tools (PRD §17: lookup, grant, transfer, revoke and
 * reset, release settings, audit log). Access is enforced server-side (users.isAdmin or ADMIN_EMAILS); the page
 * only reflects the answer. Every change needs a reason and an in-page confirm step before it is sent.
 */
import { getClerk, isClerkConfigured } from './clerk';
import { api, connectConvexAuth, convexErrorCode, convexErrorMessage, getConvex } from './convex';

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

const text = (value: unknown) => escapeHtml(value === null || value === undefined || value === '' ? '—' : String(value));
const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString() : '—');

function show(id: string, display: string) {
  const element = document.getElementById(id);
  if (element) element.style.display = display;
}

function setStatus(element: Element | null, message: string, tone: 'ok' | 'error' | '' = '') {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('ok', tone === 'ok');
  element.classList.toggle('error', tone === 'error');
}

const fieldValue = (form: HTMLFormElement, name: string) =>
  ((form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null)?.value ?? '').trim();

function setField(form: HTMLFormElement, name: string, value: string) {
  const element = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
  if (element) element.value = value;
}

// ── Stats ───────────────────────────────────────────────────────────────────

async function loadStats(): Promise<boolean> {
  try {
    const stats = await getConvex().query(api.admin.stats, {});
    show('admin-content', 'block');
    show('unauthorized', 'none');

    document.getElementById('total-plays')!.textContent = String(stats.totals.plays);
    document.getElementById('total-users')!.textContent = String(stats.totals.users);
    document.getElementById('total-purchases')!.textContent = String(stats.totals.purchases);

    document.querySelector('#recent-plays-table tbody')!.innerHTML = stats.recentPlays
      .map(
        (play) => `
          <tr>
            <td>${escapeHtml(play.track)}</td>
            <td>${escapeHtml(play.listener)}</td>
            <td>${new Date(play.playedAt).toLocaleString()}</td>
          </tr>`,
      )
      .join('');

    document.querySelector('#recent-purchases-table tbody')!.innerHTML = stats.recentPurchases
      .map(
        (purchase) => `
          <tr>
            <td>${escapeHtml(purchase.product)}</td>
            <td>${escapeHtml(purchase.buyer)}</td>
            <td>${new Date(purchase.grantedAt).toLocaleDateString()}</td>
          </tr>`,
      )
      .join('');
    return true;
  } catch (error) {
    if (convexErrorCode(error) === 'FORBIDDEN') {
      show('admin-content', 'none');
      show('unauthorized', 'flex');
      return false;
    }
    console.error('Admin stats failed:', error);
    return false;
  }
}

// ── Tabs ────────────────────────────────────────────────────────────────────

function selectTab(name: string) {
  for (const tab of document.querySelectorAll<HTMLButtonElement>('.admin-tabs [role="tab"]')) {
    const selected = tab.id === `tab-${name}`;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute('aria-controls')!);
    if (panel) panel.hidden = !selected;
  }
  if (name === 'audit' && !auditLoaded) void loadAudit(true);
}

function wireTabs() {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('.admin-tabs [role="tab"]')];
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab.id.replace('tab-', '')));
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      selectTab(next.id.replace('tab-', ''));
    });
  });
}

// ── Releases (shared by the lookup, grant and release forms) ────────────────

type Release = Awaited<ReturnType<typeof loadReleases>>[number];
let releases: Release[] = [];

async function loadReleases() {
  const rows = await getConvex().query(api.admin.releases, {});
  releases = rows;
  for (const select of document.querySelectorAll<HTMLSelectElement>('select[data-releases]')) {
    const current = select.value;
    select.innerHTML = rows
      .map((row) => `<option value="${escapeHtml(row.slug)}">${escapeHtml(row.name)} (${escapeHtml(row.slug)})</option>`)
      .join('');
    if (current) select.value = current;
  }
  fillReleaseForm();
  return rows;
}

// ── Confirm step (never window.confirm) ─────────────────────────────────────

/**
 * Shows the summary of a change inside its form with CONFIRM and CANCEL. Only CONFIRM sends it. Any edit to the
 * form after review hides the strip, so what is confirmed is what was reviewed.
 */
function askToConfirm(form: HTMLFormElement, title: string, lines: string[], run: () => Promise<string>) {
  const strip = form.querySelector<HTMLElement>('.confirm-strip')!;
  const status = form.querySelector('.admin-status');
  strip.innerHTML = `
    <strong class="admin-sub">${escapeHtml(title)}</strong>
    <ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
    <div class="admin-actions">
      <button type="button" class="primary-btn" data-confirm>CONFIRM</button>
      <button type="button" class="secondary-btn" data-cancel>CANCEL</button>
    </div>`;
  strip.hidden = false;
  setStatus(status, '');
  const confirm = strip.querySelector<HTMLButtonElement>('[data-confirm]')!;
  confirm.focus();
  strip.querySelector('[data-cancel]')!.addEventListener('click', () => {
    strip.hidden = true;
    setStatus(status, 'Cancelled. Nothing was changed.');
  });
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    try {
      const message = await run();
      strip.hidden = true;
      setStatus(status, message, 'ok');
      auditLoaded = false;
    } catch (error) {
      confirm.disabled = false;
      setStatus(status, convexErrorMessage(error, 'That did not go through.'), 'error');
    }
  });
}

function wireForm(form: HTMLFormElement, review: (form: HTMLFormElement) => void) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const status = form.querySelector('.admin-status');
    if (form.elements.namedItem('reason') && !fieldValue(form, 'reason')) {
      setStatus(status, 'A reason is required.', 'error');
      (form.elements.namedItem('reason') as HTMLTextAreaElement).focus();
      return;
    }
    try {
      review(form);
    } catch (error) {
      setStatus(status, (error as Error).message, 'error');
    }
  });
  form.addEventListener('input', () => {
    const strip = form.querySelector<HTMLElement>('.confirm-strip');
    if (strip) strip.hidden = true;
  });
}

// ── Lookup (ADM-2) ──────────────────────────────────────────────────────────

type Lookup = Awaited<ReturnType<typeof runLookup>>;

function runLookup(args: { email?: string; slug?: string; editionNumber?: number }) {
  return getConvex().query(api.admin.lookup, args);
}

function useButton(label: string, tab: string, fields: Record<string, string>) {
  const data = escapeHtml(JSON.stringify({ tab, fields }));
  return `<button type="button" class="secondary-btn mini-btn" data-use="${data}">${escapeHtml(label)}</button>`;
}

function renderLookup(result: Lookup): string {
  if (!result.found) {
    const pending = result.pendingGrants
      .map((row) => `<li>PENDING GRANT · ${text(row.slug)} · ${text(row.status)} · ${when(row.createdAt)}</li>`)
      .join('');
    return `<p class="admin-sub">No account found.</p>${pending ? `<ul class="mono-list">${pending}</ul>` : ''}`;
  }
  const account = result.account
    ? `<dl class="readout">
        <div><dt>Account ID</dt><dd>${text(result.account.id)}</dd></div>
        <div><dt>Display name</dt><dd>${text(result.account.displayName)}</dd></div>
        <div><dt>Created</dt><dd>${when(result.account.createdAt)}</dd></div>
        <div><dt>Admin</dt><dd>${result.account.isAdmin ? 'YES' : 'NO'}</dd></div>
        <div><dt>Website plays</dt><dd>${result.websitePlays.count}${result.websitePlays.capped ? '+' : ''} · last ${when(result.websitePlays.lastPlayedAt)}</dd></div>
        <div><dt>NFC tags</dt><dd>Not built yet</dd></div>
      </dl>`
    : '<p class="admin-sub">Retired edition: the account was deleted.</p>';

  const copies = result.entitlements
    .map((copy) => {
      const stats = copy.wearStats;
      const level = copy.wearLevel === null ? '—' : `${(copy.wearLevel * 100).toFixed(1)}%`;
      const refs = copy.paymentRefs
        .map((ref) => `<li>${text(ref.source)} · ${text(ref.sourceRef)} · ${text(ref.status)} · ${when(ref.at)}</li>`)
        .join('');
      const lends = copy.lends
        .map(
          (lend) =>
            `<li>LEND ${text(lend.id)} · ${text(lend.status)} · ${lend.playsUsed}/${lend.playsAllowed} plays · borrower ${text(lend.borrowerUserId)} · ends ${when(lend.expiresAt)}
            ${lend.status === 'offered' || lend.status === 'active' ? useButton('REVOKE LEND', 'revoke', { kind: 'revokeLend', target: lend.id }) : ''}</li>`,
        )
        .join('');
      const active = copy.status === 'active';
      return `
        <div class="copy-card">
          <h3>${text(copy.release)} · ${copy.editionNumber === null ? 'NO EDITION' : `#${copy.editionNumber}`}${copy.presale ? ' · PRESALE' : ''}</h3>
          <dl class="readout">
            <div><dt>Entitlement ID</dt><dd>${text(copy.id)}</dd></div>
            <div><dt>Status</dt><dd>${text(copy.status)}</dd></div>
            <div><dt>Source</dt><dd>${text(copy.source)}</dd></div>
            <div><dt>Granted</dt><dd>${when(copy.grantedAt)}</dd></div>
            <div><dt>Wear level</dt><dd class="big">${level}</dd></div>
            <div><dt>Play time</dt><dd>${stats ? `${Math.round(stats.playSeconds / 60)} min · lent ${Math.round(stats.lentPlaySeconds / 60)} min` : '—'}</dd></div>
            <div><dt>Loads / ejects</dt><dd>${stats ? `${stats.loads} / ${stats.ejects}` : '—'}</dd></div>
            <div><dt>Unwrapped</dt><dd>${when(copy.unwrappedAt)}</dd></div>
            <div><dt>App plays</dt><dd>${copy.playEvents.play}${copy.playEvents.capped ? '+' : ''} (lent ${copy.playEvents.lentPlays})</dd></div>
            <div><dt>Last played</dt><dd>${when(copy.playEvents.lastPlayedAt)}</dd></div>
          </dl>
          <p class="admin-sub">Payment refs</p>
          <ul class="mono-list">${refs || '<li>None</li>'}</ul>
          <p class="admin-sub">Lends</p>
          <ul class="mono-list">${lends || '<li>None</li>'}</ul>
          <div class="admin-actions">
            ${active ? useButton('TRANSFER', 'transfer', { entitlementId: copy.id }) : ''}
            ${active ? useButton('REVOKE', 'revoke', { kind: 'revokeEntitlement', target: copy.id }) : ''}
            ${useButton('RESET UNWRAP', 'revoke', { kind: 'resetUnwrap', target: copy.id })}
            ${useButton('RESET WEAR', 'revoke', { kind: 'resetWear', target: copy.id })}
            ${useButton('AUDIT', 'audit', { target: `entitlement:${copy.id}` })}
          </div>
        </div>`;
    })
    .join('');

  const borrowing = result.borrowing
    .map((lend) => `<li>BORROWING ${text(lend.slug)} #${text(lend.editionNumber)} · ${text(lend.status)} · ${lend.playsUsed}/${lend.playsAllowed} plays</li>`)
    .join('');
  const orders = result.orders
    .map((order) => `<li>ORDER ${text(order.stripeSessionId)} · ${(order.totalCents / 100).toFixed(2)} ${text(order.currency.toUpperCase())} · ${text(order.status)} · ${when(order.createdAt)}</li>`)
    .join('');
  const pending = result.pendingGrants
    .map((row) => `<li>PENDING GRANT · ${text(row.slug)} · ${text(row.status)}</li>`)
    .join('');
  return `${account}${copies || '<p class="admin-sub">No licences.</p>'}
    ${borrowing || orders || pending ? `<div class="copy-card"><ul class="mono-list">${borrowing}${orders}${pending}</ul></div>` : ''}`;
}

async function lookup(args: { email?: string; slug?: string; editionNumber?: number }) {
  const status = document.getElementById('lookup-status');
  const output = document.getElementById('lookup-result')!;
  setStatus(status, 'Looking up…');
  try {
    const result = await runLookup(args);
    output.innerHTML = renderLookup(result);
    setStatus(status, result.found ? '' : 'Nothing found.');
  } catch (error) {
    output.innerHTML = '';
    setStatus(status, convexErrorMessage(error, 'Lookup failed.'), 'error');
  }
}

function wireLookup() {
  const byEmail = document.getElementById('lookup-email-form') as HTMLFormElement;
  byEmail.addEventListener('submit', (event) => {
    event.preventDefault();
    void lookup({ email: fieldValue(byEmail, 'email') });
  });
  const byEdition = document.getElementById('lookup-edition-form') as HTMLFormElement;
  byEdition.addEventListener('submit', (event) => {
    event.preventDefault();
    void lookup({ slug: fieldValue(byEdition, 'slug'), editionNumber: Number(fieldValue(byEdition, 'edition')) });
  });
  // "Use" buttons prefill another panel with ids from the lookup.
  document.getElementById('lookup-result')!.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-use]');
    if (!button) return;
    const { tab, fields } = JSON.parse(button.dataset.use!) as { tab: string; fields: Record<string, string> };
    const form = document.querySelector<HTMLFormElement>(`#panel-${tab} form`);
    if (form) {
      for (const [name, value] of Object.entries(fields)) setField(form, name, value);
      form.dispatchEvent(new Event('input'));
      updateRevokeLabel();
    }
    if (tab === 'audit') auditLoaded = false;
    selectTab(tab);
  });
}

// ── Grant, transfer, revoke (ADM-3..5) ──────────────────────────────────────

function wireGrant() {
  wireForm(document.getElementById('grant-form') as HTMLFormElement, (form) => {
    const email = fieldValue(form, 'email');
    const slug = fieldValue(form, 'slug');
    const reason = fieldValue(form, 'reason');
    askToConfirm(form, 'Grant this release?', [`Release: ${slug}`, `To: ${email}`, `Reason: ${reason}`], async () => {
      const result = await getConvex().mutation(api.adminActions.grant, { email, slug, reason });
      if (result.status === 'pending') {
        return result.alreadyPending
          ? 'Already pending: it is claimed when that email signs in verified.'
          : 'No account yet: held as pending until that email signs in verified.';
      }
      const edition = result.editionNumber === null ? 'no edition yet' : `edition #${result.editionNumber}`;
      return result.status === 'already_owned' ? `Already owned (${edition}). Nothing changed.` : `Granted: ${edition}.`;
    });
  });
}

function wireTransfer() {
  wireForm(document.getElementById('transfer-form') as HTMLFormElement, (form) => {
    const entitlementId = fieldValue(form, 'entitlementId');
    const to = fieldValue(form, 'to');
    const reason = fieldValue(form, 'reason');
    askToConfirm(
      form,
      'Transfer this copy? Its open lends end as returned.',
      [`Entitlement: ${entitlementId}`, `To: ${to}`, 'Edition, wear seed and wear stats move with it.', `Reason: ${reason}`],
      async () => {
        const result = await getConvex().mutation(api.adminActions.transfer, { entitlementId, to, reason });
        return `Transferred edition #${result.editionNumber ?? '—'}. Lends ended: ${result.lendsEnded}.`;
      },
    );
  });
}

type RevokeKind = 'revokeEntitlement' | 'revokeLend' | 'resetUnwrap' | 'resetWear' | 'disableNfcTag';

const REVOKE_COPY: Record<RevokeKind, { label: string; title: string }> = {
  revokeEntitlement: { label: 'Entitlement ID', title: 'Revoke this licence? Its edition is retired and its lends end.' },
  revokeLend: { label: 'Lend ID', title: 'Revoke this lend now?' },
  resetUnwrap: { label: 'Entitlement ID', title: 'Reset the unwrap? It plays again on the next open.' },
  resetWear: { label: 'Entitlement ID', title: 'Reset the wear to zero? The seed stays.' },
  disableNfcTag: { label: 'Tag UID', title: 'Disable this NFC tag?' },
};

function updateRevokeLabel() {
  const form = document.getElementById('revoke-form') as HTMLFormElement;
  const kind = fieldValue(form, 'kind') as RevokeKind;
  document.getElementById('revoke-target-label')!.textContent = REVOKE_COPY[kind].label;
}

function wireRevoke() {
  const form = document.getElementById('revoke-form') as HTMLFormElement;
  (form.elements.namedItem('kind') as HTMLSelectElement).addEventListener('change', updateRevokeLabel);
  wireForm(form, () => {
    const kind = fieldValue(form, 'kind') as RevokeKind;
    const target = fieldValue(form, 'target');
    const reason = fieldValue(form, 'reason');
    const { label, title } = REVOKE_COPY[kind];
    askToConfirm(form, title, [`${label}: ${target}`, `Reason: ${reason}`], async () => {
      const convex = getConvex();
      switch (kind) {
        case 'revokeEntitlement': {
          const result = await convex.mutation(api.adminActions.revokeEntitlement, { entitlementId: target, reason });
          return `Revoked. Lends revoked with it: ${result.lendsRevoked}.`;
        }
        case 'revokeLend':
          await convex.mutation(api.adminActions.revokeLend, { lendId: target, reason });
          return 'Lend revoked.';
        case 'resetUnwrap':
          await convex.mutation(api.adminActions.resetUnwrap, { entitlementId: target, reason });
          return 'Unwrap reset.';
        case 'resetWear':
          await convex.mutation(api.adminActions.resetWear, { entitlementId: target, reason });
          return 'Wear reset.';
        case 'disableNfcTag':
          await convex.mutation(api.adminActions.disableNfcTag, { uid: target, reason });
          return 'Tag disabled.';
      }
    });
  });
}

// ── Release settings (ADM-7) ────────────────────────────────────────────────

/** epoch ms → the value a datetime-local input shows, in the admin's own time zone. */
function toLocalInput(ms: number | null): string {
  if (!ms) return '';
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

type ReleaseFields = {
  status: string;
  dropAt: string;
  leaderboardSize: string;
  bundleVersion: string;
  bundleUrl: string;
  bundleSha256: string;
  appStoreProductIds: string;
  accent: string;
  accent2: string;
  backdropImage: string;
  lcdTint: string;
};

function releaseFields(row: Release | undefined): ReleaseFields {
  return {
    status: row?.status ?? '',
    dropAt: toLocalInput(row?.dropAt ?? null),
    leaderboardSize: row?.leaderboardSize === null || row?.leaderboardSize === undefined ? '' : String(row.leaderboardSize),
    bundleVersion: row?.bundleVersion ?? '',
    bundleUrl: row?.bundleUrl ?? '',
    bundleSha256: row?.bundleSha256 ?? '',
    appStoreProductIds: (row?.appStoreProductIds ?? []).join(', '),
    accent: row?.theme?.accent ?? '',
    accent2: row?.theme?.accent2 ?? '',
    backdropImage: row?.theme?.backdropImage ?? '',
    lcdTint: row?.theme?.lcdTint ?? '',
  };
}

function fillReleaseForm() {
  const form = document.getElementById('release-form') as HTMLFormElement | null;
  if (!form) return;
  const current = releaseFields(releases.find((row) => row.slug === fieldValue(form, 'slug')));
  for (const [name, value] of Object.entries(current)) setField(form, name, value);
}

function wireRelease() {
  const form = document.getElementById('release-form') as HTMLFormElement;
  (form.elements.namedItem('slug') as HTMLSelectElement).addEventListener('change', fillReleaseForm);
  wireForm(form, () => {
    const slug = fieldValue(form, 'slug');
    const reason = fieldValue(form, 'reason');
    const before = releaseFields(releases.find((row) => row.slug === slug));
    const now = Object.fromEntries(Object.keys(before).map((name) => [name, fieldValue(form, name)])) as ReleaseFields;
    const changed = (names: (keyof ReleaseFields)[]) => names.some((name) => now[name] !== before[name]);

    const patch: {
      status?: 'draft' | 'scheduled' | 'live';
      dropAt?: number;
      leaderboardSize?: number;
      bundleVersion?: string;
      bundleUrl?: string;
      bundleSha256?: string;
      appStoreProductIds?: string[];
      theme?: { accent: string; accent2: string; backdropImage: string; lcdTint?: string };
    } = {};
    const lines: string[] = [];
    if (changed(['status']) && now.status) {
      patch.status = now.status as 'draft' | 'scheduled' | 'live';
      lines.push(`Status: ${before.status || '—'} → ${now.status}`);
    }
    if (changed(['dropAt']) && now.dropAt) {
      const ms = new Date(now.dropAt).getTime();
      if (!Number.isFinite(ms)) throw new Error('Enter a valid drop time.');
      patch.dropAt = ms;
      lines.push(`Drop: ${new Date(ms).toLocaleString()} (${new Date(ms).toISOString()})`);
    }
    if (changed(['leaderboardSize']) && now.leaderboardSize) {
      patch.leaderboardSize = Number(now.leaderboardSize);
      lines.push(`Leaderboard size: ${now.leaderboardSize}`);
    }
    if (changed(['bundleVersion', 'bundleUrl', 'bundleSha256'])) {
      Object.assign(patch, { bundleVersion: now.bundleVersion, bundleUrl: now.bundleUrl, bundleSha256: now.bundleSha256 });
      lines.push(`Bundle: ${now.bundleVersion} · ${now.bundleUrl} · ${now.bundleSha256.slice(0, 12)}…`);
    }
    if (changed(['appStoreProductIds'])) {
      patch.appStoreProductIds = now.appStoreProductIds.split(',').map((id) => id.trim()).filter(Boolean);
      lines.push(`App Store products: ${patch.appStoreProductIds.join(', ') || '(none)'}`);
    }
    if (changed(['accent', 'accent2', 'backdropImage', 'lcdTint'])) {
      patch.theme = {
        accent: now.accent,
        accent2: now.accent2,
        backdropImage: now.backdropImage,
        ...(now.lcdTint ? { lcdTint: now.lcdTint } : {}),
      };
      lines.push(`Theme: ${now.accent} / ${now.accent2} · ${now.backdropImage}${now.lcdTint ? ` · LCD ${now.lcdTint}` : ''}`);
    }
    if (lines.length === 0) throw new Error('Nothing has changed.');
    askToConfirm(form, `Update ${slug}?`, [...lines, `Reason: ${reason}`], async () => {
      const result = await getConvex().mutation(api.adminActions.updateRelease, { slug, reason, ...patch });
      await loadReleases();
      return `Saved: ${result.changed.join(', ')}.`;
    });
  });
}

// ── Audit log (ADM-6) ───────────────────────────────────────────────────────

let auditCursor: string | null = null;
let auditLoaded = false;

async function loadAudit(reset: boolean) {
  const form = document.getElementById('audit-form') as HTMLFormElement;
  const body = document.querySelector('#audit-table tbody')!;
  const status = document.getElementById('audit-status');
  const more = document.getElementById('audit-more') as HTMLButtonElement;
  if (reset) {
    auditCursor = null;
    body.innerHTML = '';
  }
  setStatus(status, 'Loading…');
  try {
    const target = fieldValue(form, 'target');
    const page = await getConvex().query(api.admin.auditLog, {
      paginationOpts: { numItems: 25, cursor: auditCursor },
      ...(target ? { target } : {}),
    });
    body.insertAdjacentHTML(
      'beforeend',
      page.page
        .map(
          (row) => `
          <tr>
            <td>${when(row.at)}</td>
            <td>${text(row.action)}</td>
            <td>${text(row.target)}</td>
            <td>${text(row.actorUserId)}</td>
            <td>${text(row.reason)}</td>
            <td><details><summary class="admin-sub">VIEW</summary>
              <pre>BEFORE ${escapeHtml(JSON.stringify(row.before, null, 2))}</pre>
              <pre>AFTER ${escapeHtml(JSON.stringify(row.after, null, 2))}</pre>
            </details></td>
          </tr>`,
        )
        .join(''),
    );
    auditCursor = page.continueCursor;
    more.hidden = page.isDone;
    auditLoaded = true;
    setStatus(status, body.children.length === 0 ? 'No entries.' : '');
  } catch (error) {
    setStatus(status, convexErrorMessage(error, 'Could not load the audit log.'), 'error');
  }
}

function wireAudit() {
  const form = document.getElementById('audit-form') as HTMLFormElement;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void loadAudit(true);
  });
  document.getElementById('audit-more')!.addEventListener('click', () => void loadAudit(false));
}

// ── Boot ────────────────────────────────────────────────────────────────────

function wireTools() {
  wireTabs();
  wireLookup();
  wireGrant();
  wireTransfer();
  wireRevoke();
  wireRelease();
  wireAudit();
}

async function init() {
  show('unauthorized', 'none');
  document.getElementById('refresh-stats')?.addEventListener('click', () => void loadStats());
  if (!isClerkConfigured()) return;
  const clerk = await getClerk();
  if (!clerk.user) {
    window.location.href = '/login?redirect=/admin';
    return;
  }
  if (!(await connectConvexAuth())) {
    show('unauthorized', 'flex');
    return;
  }
  if (!(await loadStats())) return;
  wireTools();
  try {
    await loadReleases();
  } catch (error) {
    console.error('Admin releases failed:', error);
  }
}

void init();
