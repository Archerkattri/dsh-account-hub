/**
 * Account Hub - client half.
 *
 * One streamlined settings page: sign in to a subscription, see every account
 * at a glance, and manage it. Detail that is not needed on every visit (token
 * expiry, paid-through date, model list, cooldown reason) folds into a per-card
 * "Details" disclosure so the page stays quiet.
 *
 * Colours are explicit where contrast matters (buttons, chips, badges) and
 * follow the theme for surfaces, so the page sits in either appearance.
 *
 * @module @local/dsh-account-hub
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-account-hub',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const API = '/plugins/account-hub'

    const PROVIDER_LABELS = {
      codex: 'ChatGPT',
      claude: 'Claude',
      antigravity: 'Google Antigravity',
      xai: 'Grok',
      kimi: 'Kimi',
      'kimi-ai': 'Kimi AI',
      meta: 'Meta',
      devin: 'Devin',
    }

    const PRIMARY_PROVIDERS = ['codex', 'claude', 'antigravity']

    const C = {
      text: 'var(--dsw-alias-label-primary, #e6e8eb)',
      sub: 'var(--dsw-alias-label-secondary, #9ca6b2)',
      border: 'var(--dsw-alias-border-l1, rgba(128, 138, 152, .30))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(128, 138, 152, .50))',
      surface: 'var(--dsw-alias-bg-layer-1, #1a1e23)',
      surface2: 'var(--dsw-alias-bg-layer-2, #22272e)',
      blue: '#2f6feb',
      blueHover: '#3b7bf7',
      green: '#2ea36b',
      amber: '#d98a1a',
      red: '#e5534b',
      white: '#ffffff',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }

    /** Call the Host half. */
    async function api(path, init = {}) {
      const response = await fetch(`${API}${path}`, {
        credentials: 'same-origin',
        headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
        ...init,
      })
      const text = await response.text()
      const body = text.length > 0 ? JSON.parse(text) : {}
      if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`)
      return body
    }

    /** Short local date from an ISO timestamp, or undefined. */
    function shortDate(value) {
      if (typeof value !== 'string') return undefined
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return undefined
      return date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    }

    /** Pill. */
    function Chip({ children, tone = 'neutral', title }) {
      const tones = {
        neutral: { color: C.sub, background: 'rgba(128,138,152,.14)', border: 'rgba(128,138,152,.30)' },
        ok: { color: C.green, background: 'rgba(46,163,107,.14)', border: 'rgba(46,163,107,.40)' },
        warn: { color: C.amber, background: 'rgba(217,138,26,.14)', border: 'rgba(217,138,26,.40)' },
        error: { color: C.red, background: 'rgba(229,83,75,.14)', border: 'rgba(229,83,75,.40)' },
        brand: { color: C.blue, background: 'rgba(47,111,235,.16)', border: 'rgba(47,111,235,.42)' },
      }
      return h('span', {
        title,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '1px 7px', borderRadius: 6, border: `1px solid ${tones[tone].border}`,
          color: tones[tone].color, background: tones[tone].background,
          fontSize: 11, fontWeight: 500, lineHeight: '16px', whiteSpace: 'nowrap',
        },
      }, children)
    }

    /** Button with guaranteed contrast in both appearances. */
    function Button({ children, onClick, variant = 'default', disabled = false, title, small = false, style }) {
      const variants = {
        default: { background: 'rgba(128,138,152,.12)', color: C.text, border: `1px solid ${C.borderStrong}` },
        primary: { background: C.blue, color: C.white, border: '1px solid transparent' },
        ghost: { background: 'transparent', color: C.sub, border: '1px solid transparent' },
        danger: { background: 'rgba(229,83,75,.12)', color: C.red, border: '1px solid rgba(229,83,75,.45)' },
      }
      return h('button', {
        type: 'button',
        title,
        disabled,
        onClick,
        onMouseEnter: event => { if (!disabled && variant === 'primary') event.currentTarget.style.background = C.blueHover },
        onMouseLeave: event => { if (variant === 'primary') event.currentTarget.style.background = C.blue },
        style: {
          ...variants[variant],
          ...style,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          padding: small ? '3px 8px' : '6px 12px', borderRadius: 8,
          fontSize: small ? 11.5 : 12, fontWeight: 600,
          lineHeight: '18px', cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.55 : 1, whiteSpace: 'nowrap',
        },
      }, children)
    }

    /** Request sparkline for the last buckets. */
    function UsageBars({ recent }) {
      const buckets = Array.isArray(recent) ? recent : []
      if (buckets.length === 0) return null
      const peak = Math.max(1, ...buckets.map(bucket => bucket.success + bucket.failed))
      return h('div', {
        style: { display: 'flex', alignItems: 'flex-end', gap: 2, height: 16 },
        title: buckets.map(bucket => `${bucket.time}: ${bucket.success} ok / ${bucket.failed} failed`).join('\n'),
      }, buckets.map((bucket, index) => {
        const total = bucket.success + bucket.failed
        const height = total === 0 ? 3 : Math.max(4, Math.round((total / peak) * 16))
        const colour = total === 0 ? C.borderStrong : bucket.failed > bucket.success ? C.red : C.green
        return h('div', {
          key: `${bucket.time}-${index}`,
          style: { width: 4, height, borderRadius: 2, background: colour, opacity: total === 0 ? 0.55 : 1 },
        })
      }))
    }

    /** Human label for a usage window. */
    function windowLabel(window) {
      if (window === '5h') return '5h'
      if (window === 'weekly') return 'week'
      return 'limit'
    }

    /** Time until an epoch-seconds instant, or undefined when unknown. */
    function until(epochSeconds) {
      if (!Number.isFinite(epochSeconds)) return undefined
      const ms = epochSeconds * 1000 - Date.now()
      if (ms <= 0) return 'now'
      const minutes = Math.round(ms / 60000)
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      if (hours < 48) return `${hours}h ${minutes % 60}m`
      return `${Math.round(hours / 24)}d`
    }

    /** Absolute local reset time for a tooltip. */
    function resetTitle(epochSeconds) {
      if (!Number.isFinite(epochSeconds)) return undefined
      return new Date(epochSeconds * 1000).toLocaleString()
    }

    /** One usage window: label, used bar, percent, and when it resets. */
    function UsageBar({ usage }) {
      if (usage === undefined || !Number.isFinite(usage?.usedPercent)) return null
      const pct = Math.max(0, Math.min(100, usage.usedPercent))
      const colour = pct >= 95 ? C.red : pct >= 80 ? C.amber : C.green
      const left = until(usage.resetsAtEpoch)
      const label = usage.group === undefined
        ? windowLabel(usage.window)
        : `${usage.group} ${windowLabel(usage.window)}`
      const title = [
        usage.group === undefined ? undefined : usage.group,
        `${Math.round(pct)}% used`,
        resetTitle(usage.resetsAtEpoch) === undefined ? undefined : `resets ${resetTitle(usage.resetsAtEpoch)}`,
      ].filter(part => part !== undefined).join(' · ')
      return h('div', {
        title,
        style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      },
      h('span', {
        style: {
          fontSize: 10.5, color: C.sub, width: 88, flex: '0 0 auto',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        },
      }, label),
      h('div', { style: { flex: 1, minWidth: 60, height: 4, borderRadius: 999, background: 'rgba(128,138,152,.28)', overflow: 'hidden' } },
        h('div', { style: { width: `${pct}%`, height: '100%', background: colour, borderRadius: 999 } })),
      h('span', { style: { fontSize: 10.5, color: colour, fontWeight: 700, width: 34, textAlign: 'right', flex: '0 0 auto' } }, `${Math.round(pct)}%`),
      h('span', {
        style: { fontSize: 10.5, color: C.sub, width: 76, textAlign: 'right', flex: '0 0 auto', whiteSpace: 'nowrap' },
      }, left === undefined ? '' : `resets ${left}`))
    }

    /** A quiet key/value line used inside the Details disclosure. */
    function Fact({ label, children }) {
      return h('div', { style: { display: 'flex', gap: 8, fontSize: 11.5, lineHeight: 1.5 } },
        h('span', { style: { color: C.sub, flex: '0 0 92px' } }, label),
        h('span', { style: { color: C.text, minWidth: 0, wordBreak: 'break-word' } }, children))
    }

    /** One compact account row: identity, quota, quiet actions, folded detail. */
    function AccountCard({ account, busy, onAction }) {
      const [confirming, setConfirming] = useState(false)
      const [renaming, setRenaming] = useState(false)
      const [draftLabel, setDraftLabel] = useState('')
      const cooling = (Array.isArray(account.cooldowns) && account.cooldowns.length > 0) || account.quotaBlocked
      const state = account.disabled ? 'disabled' : account.requiresSignIn ? 'sign-in needed' : cooling ? 'cooling down' : 'active'
      const tone = state === 'active' ? 'ok' : state === 'disabled' ? 'neutral' : 'warn'
      const dot = state === 'active' ? C.green : state === 'disabled' ? C.borderStrong : C.amber
      const title = account.displayLabel ?? account.label ?? account.name
      const secondary = account.email !== undefined && account.email !== title ? account.email : undefined
      const limits = account.limits ?? {}
      const usage = Array.isArray(account.usage) ? account.usage : []

      const actions = confirming
        ? h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          h('span', { style: { fontSize: 11.5, color: C.red } }, 'Remove?'),
          h(Button, { small: true, variant: 'danger', disabled: busy, onClick: () => { setConfirming(false); onAction('remove', account) } }, 'Yes'),
          h(Button, { small: true, variant: 'ghost', onClick: () => setConfirming(false) }, 'No'))
        : h('div', { style: { display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' } },
          h(Button, { small: true, variant: 'ghost', disabled: busy, onClick: () => onAction(account.disabled ? 'enable' : 'disable', account) }, account.disabled ? 'Enable' : 'Disable'),
          cooling ? h(Button, { small: true, variant: 'ghost', disabled: busy, title: 'Clear the cooldown and retry', onClick: () => onAction('reset-cooldown', account) }, 'Reset') : null,
          h(Button, { small: true, variant: 'ghost', disabled: busy, title: 'Refresh the OAuth token', onClick: () => onAction('refresh', account) }, 'Refresh'),
          h(Button, { small: true, variant: 'ghost', disabled: busy, onClick: () => { setDraftLabel(String(account.displayLabel ?? account.label ?? '')); setRenaming(true) } }, 'Rename'),
          h(Button, { small: true, variant: 'ghost', disabled: busy, style: { color: C.red }, onClick: () => setConfirming(true) }, 'Remove'))

      const renameForm = h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
        h('input', {
          type: 'text', value: draftLabel, maxLength: 80, placeholder: 'Display name', autoFocus: true,
          onChange: event => setDraftLabel(event.currentTarget.value),
          onKeyDown: event => {
            if (event.key === 'Enter' && draftLabel.trim().length > 0) { setRenaming(false); onAction('rename', account, { label: draftLabel.trim() }) }
            if (event.key === 'Escape') setRenaming(false)
          },
          style: {
            flex: '1 1 180px', minWidth: 140, padding: '4px 8px', borderRadius: 8,
            border: `1px solid ${C.borderStrong}`, background: C.surface, color: C.text, fontSize: 12, outline: 'none',
          },
        }),
        h(Button, { small: true, variant: 'primary', disabled: busy || draftLabel.trim().length === 0, onClick: () => { setRenaming(false); onAction('rename', account, { label: draftLabel.trim() }) } }, 'Save'),
        h(Button, { small: true, variant: 'ghost', onClick: () => setRenaming(false) }, 'Cancel'))

      // Folded detail: everything not needed on every visit.
      const detailRows = []
      if (account.plan !== undefined) detailRows.push(h(Fact, { key: 'plan', label: 'Plan' }, account.plan))
      if (account.subscriptionUntil !== undefined) detailRows.push(h(Fact, { key: 'paid', label: 'Paid through' }, shortDate(account.subscriptionUntil)))
      if (account.expiresAt !== undefined) detailRows.push(h(Fact, { key: 'token', label: 'Token expiry' }, shortDate(account.expiresAt)))
      if (limits.activeLimit !== undefined) detailRows.push(h(Fact, { key: 'tier', label: 'Limit tier' }, limits.activeLimit))
      if (limits.credits !== undefined) detailRows.push(h(Fact, { key: 'credits', label: 'Credits' }, limits.credits))
      if (account.cooldown !== undefined) {
        detailRows.push(h(Fact, { key: 'cool', label: 'Cooldown' },
          `${account.cooldown.reason ?? 'cooling'}${account.cooldown.remainingSeconds !== undefined ? ` - ${Math.round(account.cooldown.remainingSeconds / 60)}m left` : ''}`))
      }
      if (account.failure !== undefined) {
        detailRows.push(h(Fact, { key: 'fail', label: 'Last error' },
          h('span', { style: { color: C.red } }, account.failure.message)))
      }
      const models = Array.isArray(account.models) && account.models.length > 0
        ? h(Fact, { key: 'models', label: `Models (${account.models.length})` },
          h('span', { style: { fontFamily: C.mono, fontSize: 10.5, color: C.sub } }, account.models.join(', ')))
        : null
      const hasDetail = detailRows.length > 0 || models !== null

      return h('article', {
        style: {
          border: `1px solid ${C.border}`, borderRadius: 10, background: C.surface2,
          padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
        },
      },
      // Identity + state + actions on one line.
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', minWidth: 0, flexWrap: 'wrap' } },
        h('span', { 'aria-hidden': true, style: { width: 8, height: 8, borderRadius: 999, flex: '0 0 auto', background: dot } }),
        h('span', {
          title,
          style: { fontSize: 13, fontWeight: 650, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 },
        }, title),
        secondary === undefined ? null : h('span', {
          title: secondary,
          style: { fontSize: 11, color: C.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 },
        }, secondary),
        h(Chip, { tone }, state),
        h('div', { style: { flex: 1 } }),
        renaming ? null : actions),
      // Usage windows (5-hour + weekly), then the request sparkline.
      (usage.length > 0 || account.usageError !== undefined || account.success > 0 || account.failed > 0)
        ? h('div', { style: { display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' } },
          usage.length > 0
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 320px', minWidth: 240 } },
              usage.map((entry, index) => h(UsageBar, { key: `${entry.group ?? ''}-${entry.window}-${index}`, usage: entry })))
            : account.usageError !== undefined
              ? h('span', { title: account.usageError, style: { fontSize: 10.5, color: C.sub, flex: '0 0 auto' } }, 'usage unavailable')
              : null,
          account.success > 0 || account.failed > 0
            ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto' } },
              h(UsageBars, { recent: account.recent }),
              h('span', { style: { fontSize: 11, color: C.sub, whiteSpace: 'nowrap' } }, `${account.success} ok / ${account.failed} failed`))
            : null)
        : null,
      renaming ? renameForm : null,
      hasDetail
        ? h('details', null,
          h('summary', { style: { cursor: 'pointer', fontSize: 11, color: C.sub, userSelect: 'none' } }, 'Details'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 } },
            detailRows, models))
        : null)
    }

    /** Sign-in progress panel. */
    function LoginDialog({ session, onCancel, onFinished }) {
      const [status, setStatus] = useState('wait')
      const [error, setError] = useState()
      const opened = useRef(false)

      useEffect(() => {
        if (opened.current) return
        opened.current = true
        try { window.open(session.url, '_blank', 'noopener,noreferrer') } catch { /* the link below still works */ }
      }, [session.url])

      useEffect(() => {
        let alive = true
        const timer = setInterval(async () => {
          try {
            const result = await api(`/login/status?state=${encodeURIComponent(session.state)}`)
            if (!alive) return
            if (result.status === 'ok') { clearInterval(timer); onFinished() }
            else if (result.status === 'error') { clearInterval(timer); setStatus('error'); setError(result.error ?? 'sign-in failed') }
          } catch (failure) {
            if (!alive) return
            clearInterval(timer); setStatus('error'); setError(String(failure.message ?? failure))
          }
        }, 2000)
        return () => { alive = false; clearInterval(timer) }
      }, [session.state, onFinished])

      const providerLabel = PROVIDER_LABELS[session.provider] ?? session.provider
      return h('div', {
        style: {
          border: `1px solid ${C.blue}`, borderRadius: 10, padding: '12px 14px',
          background: 'rgba(47,111,235,.08)', display: 'flex', flexDirection: 'column', gap: 8,
        },
      },
      h('div', { style: { fontSize: 13, fontWeight: 700, color: C.text } }, `Signing in to ${providerLabel}`),
      h('div', { style: { fontSize: 12, color: C.sub, lineHeight: 1.5 } },
        'Finish the sign-in in the browser tab that opened. This closes itself when the account lands.'),
      session.userCode !== undefined
        ? h('div', {
          style: {
            fontFamily: C.mono, fontSize: 18, letterSpacing: 2, padding: '6px 10px',
            border: `1px dashed ${C.borderStrong}`, borderRadius: 8, color: C.text, userSelect: 'all', alignSelf: 'flex-start',
          },
        }, session.userCode) : null,
      status === 'error'
        ? h('div', { style: { fontSize: 12, color: C.red } }, error)
        : h('div', { style: { fontSize: 12, color: C.sub } }, 'Waiting for sign-in...'),
      h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
        h('a', { href: session.url, target: '_blank', rel: 'noopener noreferrer', style: { fontSize: 11.5, color: C.blue, wordBreak: 'break-all' } }, 'Open sign-in page again'),
        h('div', { style: { flex: 1 } }),
        h(Button, { small: true, variant: 'ghost', onClick: () => { void onCancel().catch(() => undefined) } }, 'Cancel')))
    }

    /** Recent subagents with the route and effort each one used. */
    function SubagentStrip({ subagents }) {
      if (!Array.isArray(subagents) || subagents.length === 0) return null
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, border: `1px solid ${C.borderStrong}`, borderRadius: 10, padding: '10px 12px' } },
        h('div', { style: { fontSize: 11.5, fontWeight: 700, color: C.text } }, 'Recent subagents'),
        subagents.map(entry => h('div', { key: entry.id, title: `${entry.label ?? entry.name}${entry.title ? ` — ${entry.title}` : ''}\n${entry.provider ?? '?'}/${entry.model ?? '?'}${entry.effort ? ` · ${entry.effort} effort` : ''}`, style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11.5, flexWrap: 'wrap', cursor: 'default' } },
          h('span', { style: { fontWeight: 600, color: C.text } }, entry.label ?? entry.name ?? entry.id),
          h('span', { style: { color: C.sub, fontFamily: C.mono, fontSize: 10.5 } },
            entry.model === undefined ? 'route unknown' : `${entry.provider}/${entry.model}${entry.effort ? ` · ${entry.effort}` : ''}`))))
    }

    /** Plan and quota strip: OpenCode Go windows and the Qwen plan state. */
    function QuotaStrip({ quota }) {
      if (quota === undefined) return null
      const opencode = quota.opencode
      const qwen = quota.qwen
      const label = window => window === '5h' ? '5h' : window === 'weekly' ? 'week' : window === 'monthly' ? 'month' : 'limit'
      const fmtReset = epoch => {
        if (!Number.isFinite(epoch)) return ''
        const date = new Date(epoch * 1000)
        return `resets ${date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
      }
      const bar = entry => {
        const used = Math.max(0, Math.min(100, Number(entry.usedPercent) || 0))
        const remaining = 100 - used
        const tone = remaining <= 10 ? C.red : remaining <= 30 ? '#d9a441' : C.green
        return h('div', { key: entry.window, title: `${left}% of this window remains${Number.isFinite(entry.resetsAtEpoch) ? `; resets ${new Date(entry.resetsAtEpoch * 1000).toLocaleString()}` : ''}`, style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 11.5 } },
          h('span', { style: { width: 42, color: C.sub } }, label(entry.window)),
          h('div', { style: { flex: 1, height: 6, borderRadius: 4, background: C.borderStrong, overflow: 'hidden' } },
            h('div', { style: { width: `${remaining}%`, height: '100%', background: tone, borderRadius: 4 } })),
          h('span', { style: { width: 42, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: remaining <= 10 ? C.red : C.text } }, `${remaining}% left`),
          h('span', { style: { width: 118, color: C.sub, fontSize: 10.5 } }, fmtReset(entry.resetsAtEpoch)))
      }
      const rows = []
      if (opencode !== undefined) {
        rows.push(h('div', { key: 'opencode', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
            h('span', { style: { fontSize: 11.5, fontWeight: 700, color: C.sub } }, 'OpenCode Go'),
            h('span', { style: { fontSize: 11, color: C.sub } }, opencode.plan ?? ''),
            opencode.error !== undefined ? h('span', { style: { fontSize: 10.5, color: C.red } }, opencode.error) : null),
          (opencode.windows ?? []).map(bar)))
      }
      if (qwen !== undefined) {
        rows.push(h('div', { key: 'qwen', style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11.5 } },
          h('span', { style: { fontWeight: 700, color: C.sub } }, 'Qwen Cloud'),
          h('span', { style: { color: C.sub, fontSize: 11 } }, qwen.plan ?? ''),
          h('span', { style: { color: C.sub, fontSize: 10.5 } }, qwen.note ?? '')))
      }
      if (rows.length === 0) return null
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, border: `1px solid ${C.borderStrong}`, borderRadius: 10, padding: '10px 12px' } },
        h('div', { style: { fontSize: 11.5, fontWeight: 700, color: C.text } }, 'Plans & quota'),
        rows)
    }

    /** The Accounts settings section. */
    function AccountsSection() {
      const [state, setState] = useState()
      const [error, setError] = useState()
      const [busy, setBusy] = useState(false)
      const [session, setSession] = useState()
      const [notice, setNotice] = useState()
      const [syncBusy, setSyncBusy] = useState(false)

      const refresh = useCallback(async () => {
        try {
          const next = await api('/state')
          setState(next)
          setError(next.proxy?.error ?? undefined)
        } catch (failure) {
          setError(String(failure.message ?? failure))
        }
      }, [])

      useEffect(() => {
        void refresh()
        const timer = setInterval(() => { void refresh() }, 15000)
        return () => clearInterval(timer)
      }, [refresh])

      const startLogin = useCallback(async provider => {
        setBusy(true); setError(undefined)
        try {
          const result = await api('/login', { method: 'POST', body: JSON.stringify({ provider }) })
          setSession({ ...result, provider })
        } catch (failure) { setError(String(failure.message ?? failure)) }
        finally { setBusy(false) }
      }, [])

      const cancelLogin = useCallback(async () => {
        const current = session
        setSession(undefined)
        if (current?.state !== undefined) await api(`/login?state=${encodeURIComponent(current.state)}`, { method: 'DELETE' })
      }, [session])

      const finishLogin = useCallback(() => {
        setSession(undefined); setNotice('Account added.'); void refresh()
      }, [refresh])

      const runAction = useCallback(async (action, account, extra) => {
        setBusy(true); setError(undefined)
        try {
          await api('/account', { method: 'POST', body: JSON.stringify({ action, name: account.name, ...(extra ?? {}) }) })
          setNotice(action === 'remove' ? 'Account removed.' : action === 'rename' ? 'Name saved.' : 'Account updated.')
          await refresh()
        } catch (failure) { setError(String(failure.message ?? failure)) }
        finally { setBusy(false) }
      }, [refresh])

      const setRouting = useCallback(async strategy => {
        setBusy(true); setError(undefined)
        try {
          await api('/routing', { method: 'POST', body: JSON.stringify({ strategy }) })
          await refresh()
        } catch (failure) { setError(String(failure.message ?? failure)) }
        finally { setBusy(false) }
      }, [refresh])

      const setAccountSelection = useCallback(async (provider, name) => {
        setBusy(true); setError(undefined)
        try {
          const result = await api('/account-selection', {
            method: 'POST', body: JSON.stringify({ provider, name }),
          })
          setNotice(result.message ?? 'Account selection updated.')
          await refresh()
        } catch (failure) { setError(String(failure.message ?? failure)) }
        finally { setBusy(false) }
      }, [refresh])

      const setAffinity = useCallback(async enabled => {
        setBusy(true); setError(undefined)
        try {
          await api('/affinity', { method: 'POST', body: JSON.stringify({ enabled }) })
          await refresh()
        } catch (failure) { setError(String(failure.message ?? failure)) }
        finally { setBusy(false) }
      }, [refresh])

      const syncModels = useCallback(async () => {
        setSyncBusy(true); setError(undefined)
        try {
          const result = await api('/sync-models', { method: 'POST' })
          const added = Array.isArray(result.added) ? result.added.length : 0
          const removed = Array.isArray(result.removed) ? result.removed.length : 0
          setNotice(added === 0 && removed === 0 ? 'Model lists already match the proxy.' : `Models synced: ${added} added, ${removed} removed.`)
          await refresh()
        } catch (failure) { setError(String(failure.message ?? failure)) }
        finally { setSyncBusy(false) }
      }, [refresh])

      useEffect(() => {
        if (notice === undefined) return undefined
        const timer = setTimeout(() => setNotice(undefined), 4000)
        return () => clearTimeout(timer)
      }, [notice])

      const accounts = state?.accounts ?? []
      const providers = state?.providers ?? []
      const wired = (state?.routes ?? []).filter(route => /^cliproxy/.test(String(route.provider)))
      const routing = state?.routing
      const affinity = state?.affinity === true
      const running = state?.proxy?.running === true

      const grouped = []
      for (const account of accounts) {
        let group = grouped.find(entry => entry.provider === account.provider)
        if (group === undefined) { group = { provider: account.provider, accounts: [] }; grouped.push(group) }
        group.accounts.push(account)
      }
      for (const group of grouped) group.accounts.sort((a, b) => String(a.label ?? '').localeCompare(String(b.label ?? '')))

      const byId = new Map(providers.map(provider => [provider.id, provider]))

      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720, fontSize: 13, color: C.text, lineHeight: 1.45 },
      },
      // Header: title + one-line purpose + sync action.
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
        h('h2', { style: { margin: 0, fontSize: 17, fontWeight: 700 } }, 'Accounts'),
        h('span', { style: { fontSize: 12, color: C.sub } }, 'your AI subscriptions, shared across requests'),
        h('div', { style: { flex: 1 } }),
        wired.length > 0 ? h(Button, {
          small: true, disabled: syncBusy, title: "Refresh the model lists from the proxy's live catalog",
          onClick: () => { void syncModels() },
        }, syncBusy ? 'Syncing...' : 'Sync models') : null),
      error !== undefined
        ? h('div', { style: { fontSize: 12, color: C.red, border: '1px solid rgba(229,83,75,.45)', background: 'rgba(229,83,75,.10)', borderRadius: 10, padding: '10px 12px', lineHeight: 1.5 } }, error)
        : null,
      notice !== undefined ? h('div', { style: { fontSize: 12, color: C.green } }, notice) : null,
      h(QuotaStrip, { quota: state?.quota }),
      h(SubagentStrip, { subagents: state?.subagents }),
      session !== undefined ? h(LoginDialog, { session, onCancel: cancelLogin, onFinished: finishLogin }) : null,
      // Sign-in: one compact row of providers.
      running
        ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
          h('span', { style: { fontSize: 11.5, color: C.sub, marginRight: 2 } }, 'Sign in:'),
          providers.map(provider => h(Button, {
            key: provider.id,
            small: true,
            variant: PRIMARY_PROVIDERS.includes(provider.id) ? 'primary' : 'default',
            disabled: busy, title: provider.hint,
            onClick: () => { void startLogin(provider.id) },
          }, byId.get(provider.id)?.name ?? provider.name)))
        : h('div', { style: { fontSize: 12, border: `1px dashed ${C.borderStrong}`, borderRadius: 10, padding: '12px 14px', lineHeight: 1.6, color: C.sub } },
          h('span', { style: { fontWeight: 700, color: C.text } }, 'The account proxy is not running. '),
          'Install CLIProxyAPI with ',
          h('code', { style: { fontFamily: C.mono, fontSize: 11.5, color: C.text } }, 'winget install -e --id LuisPater.CLIProxyAPI'),
          ' (or set ', h('code', { style: { fontFamily: C.mono, fontSize: 11.5, color: C.text } }, 'CLIPROXY_BIN'), '), then reload.'),
      // Rotation: one quiet row.
      running ? h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
        h('span', { style: { fontSize: 11.5, color: C.sub } }, 'Rotation:'),
        h('div', { style: { display: 'inline-flex', border: `1px solid ${C.borderStrong}`, borderRadius: 8, overflow: 'hidden' } },
          h('button', {
            type: 'button', disabled: busy, onClick: () => { void setRouting('round-robin') },
            title: 'Spread requests across every account',
            style: {
              padding: '4px 10px', fontSize: 11.5, fontWeight: 600, border: 'none', cursor: busy ? 'default' : 'pointer',
              background: routing === 'round-robin' ? C.blue : 'transparent', color: routing === 'round-robin' ? C.white : C.sub,
            },
          }, 'Round-robin'),
          h('button', {
            type: 'button', disabled: busy, onClick: () => { void setRouting('fill-first') },
            title: 'Drain one account before using the next',
            style: {
              padding: '4px 10px', fontSize: 11.5, fontWeight: 600, border: 'none', cursor: busy ? 'default' : 'pointer',
              background: routing === 'fill-first' ? C.blue : 'transparent', color: routing === 'fill-first' ? C.white : C.sub,
            },
          }, 'Fill first')),
        h('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 11.5, color: C.sub, cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: affinity, disabled: busy, onChange: event => { void setAffinity(event.currentTarget.checked) } }),
          'Pin conversations to one account')) : null,
      // Accounts, grouped by provider. Fill first offers an exclusive account
      // selector only when there are multiple usable accounts for that provider.
      accounts.length === 0
        ? h('div', { style: { fontSize: 12, color: C.sub, border: `1px dashed ${C.borderStrong}`, borderRadius: 10, padding: '12px 14px' } }, 'No accounts yet - sign one in above.')
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          grouped.map(group => {
            const candidates = group.accounts.filter(account => account.selectableForProvider === true)
            const selected = state?.accountSelections?.[group.provider]?.selected ?? ''
            const showSelector = (routing === 'fill-first' && candidates.length > 1) || selected !== ''
            const selectedName = group.accounts.find(account => account.name === selected)
            const selectStyle = {
              minWidth: 180, maxWidth: '100%', padding: '4px 8px', borderRadius: 7,
              border: `1px solid ${C.borderStrong}`, background: C.surface, color: C.text,
              fontSize: 11.5, outline: 'none',
            }
            return h('div', { key: group.provider, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { style: { fontSize: 11.5, fontWeight: 700, color: C.sub } }, PROVIDER_LABELS[group.provider] ?? group.provider),
                group.accounts.length > 1 ? h('span', { style: { fontSize: 11, color: C.sub } }, `${group.accounts.length} accounts`) : null,
                showSelector ? h('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginLeft: 'auto' } },
                  h('span', { style: { fontSize: 11, color: C.sub } }, 'Account:'),
                  h('select', {
                    value: selected,
                    disabled: busy,
                    'aria-label': `Account to use for ${PROVIDER_LABELS[group.provider] ?? group.provider}`,
                    onChange: event => { void setAccountSelection(group.provider, event.currentTarget.value || null) },
                    style: selectStyle,
                  },
                  h('option', { value: '' }, 'Auto - all enabled accounts'),
                  candidates.map(account => h('option', { key: account.name, value: account.name },
                    `${account.displayLabel ?? account.label ?? account.name}${account.email ? ` · ${account.email}` : ''}`)),
                  selected && !candidates.some(account => account.name === selected) && selectedName
                    ? h('option', { value: selected }, `${selectedName.displayLabel ?? selectedName.label ?? selectedName.name} · currently selected`)
                    : null),
                  h('span', {
                    title: 'Exclusive selection: only the chosen account is enabled for this provider until Auto is restored.',
                    style: { fontSize: 10.5, color: C.sub },
                  }, selected ? 'Only selected account is enabled; Auto restores the prior pool.' : 'Auto uses every enabled account.')) : null),
              group.accounts.map(account => h(AccountCard, { key: account.id, account, busy, onAction: runAction })))
          })),
      // Routes: a single quiet summary line.
      wired.length > 0
        ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11.5, color: C.sub } },
          h('span', null, 'Routes:'),
          wired.map(route => h(Chip, { key: route.provider, tone: route.models.length > 0 ? 'neutral' : 'warn', title: route.models.join(', ') },
            `${route.provider} - ${route.models.length}`)))
        : null)
    }

    /** Compact quota + subagent bar above the composer; no Settings trip needed. */
    function QuotaDock() {
      const [state, setState] = useState()
      const [open, setOpen] = useState(false)
      useEffect(() => {
        let live = true
        const load = async () => {
          try {
            const next = await api('/state')
            if (live) setState(next)
          } catch { /* keep the last snapshot */ }
        }
        void load()
        const timer = setInterval(() => { void load() }, 30000)
        return () => { live = false; clearInterval(timer) }
      }, [])
      const quota = state?.quota
      const opencode = quota?.opencode
      const windows = opencode?.windows ?? []
      const windowLeft = (list, window) => {
        const entry = (list ?? []).find(item => item.window === window)
        if (entry === undefined) return undefined
        return Math.max(0, 100 - Math.round(Number(entry.usedPercent) || 0))
      }
      const oc5 = windowLeft(windows, '5h')
      const resetOf = (list, window) => {
        const entry = (list ?? []).find(item => item.window === window)
        return Number.isFinite(entry?.resetsAtEpoch) ? new Date(entry.resetsAtEpoch * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : undefined
      }
      const accountUsage = (state?.accounts ?? []).filter(account => Array.isArray(account.usage) && account.usage.length > 0)
      const gpt5 = accountUsage.map(account => windowLeft(account.usage, '5h')).filter(value => value !== undefined)
      const gptWorst = gpt5.length === 0 ? undefined : Math.min(...gpt5)
      const gptTitle = accountUsage.length === 0
        ? 'No ChatGPT account usage reported'
        : accountUsage.map((account, index) => `ChatGPT ${index + 1}: ${windowLeft(account.usage, '5h') ?? '?'}% 5h left, ${windowLeft(account.usage, 'weekly') ?? '?'}% week left`).join('\n')
      const qwen = quota?.qwen
      const subagents = Array.isArray(state?.subagents) ? state.subagents : []
      const latest = subagents[0]
      const toneFor = value => value === undefined ? C.sub : value <= 10 ? C.red : value <= 30 ? '#d9a441' : C.green
      const chipStyle = { display: 'inline-flex', alignItems: 'center', gap: 5, border: `1px solid ${C.borderStrong}`, background: 'transparent', color: C.sub, borderRadius: 999, padding: '2px 9px', fontSize: 10.5, cursor: 'pointer' }
      const chip = (key, dot, label, title) => h('button', {
        key, type: 'button', title,
        onClick: () => setOpen(value => !value),
        style: chipStyle,
      }, dot === undefined ? null : h('span', { style: { width: 6, height: 6, borderRadius: 6, background: dot, display: 'inline-block' } }), h('span', null, label))
      const ocTitle = ['OpenCode Go — Go plan', ...windows.map(entry => `${entry.window === 'monthly' ? 'month' : entry.window === 'weekly' ? 'week' : entry.window}: ${Math.max(0, 100 - Math.round(Number(entry.usedPercent) || 0))}% left${Number.isFinite(entry.resetsAtEpoch) ? `, resets ${new Date(entry.resetsAtEpoch * 1000).toLocaleString()}` : ''}`)].join('\n')
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, color: C.sub } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          chip('oc', toneFor(oc5), `OC 5h ${oc5 === undefined ? '—' : `${oc5}%`}`, ocTitle),
          chip('gpt', toneFor(gptWorst), `GPT 5h ${gptWorst === undefined ? '—' : `${gptWorst}%`}`, gptTitle),
          chip('qwen', C.sub, 'QW 5h —', `${qwen?.plan ?? 'Qwen plan'} — the token-plan API exposes no usage endpoint; a 429 means this window is exhausted.`),
          latest !== undefined
            ? chip('subs', undefined, `recent ${subagents.length}`, `Recent subagent sessions (not currently running). The newest: ${latest.label ?? latest.name} used ${latest.provider ?? '?'}/${latest.model ?? '?'}${latest.effort ? ` at ${latest.effort} effort` : ''}. Click for all.`)
            : null),
        open
          ? h('div', { style: { border: `1px solid ${C.borderStrong}`, borderRadius: 10, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4, background: 'var(--dsw-alias-bg-l1, transparent)' } },
            windows.map(entry => {
              const left = Math.max(0, 100 - Math.round(Number(entry.usedPercent) || 0))
              const reset = Number.isFinite(entry.resetsAtEpoch) ? new Date(entry.resetsAtEpoch * 1000).toLocaleString() : undefined
              return h('div', { key: entry.window, title: `${left}% of the OpenCode ${entry.window} window remains${reset ? `; resets ${reset}` : ''}`, style: { display: 'flex', gap: 8, cursor: 'default' } },
                h('span', { style: { width: 38, opacity: .7 } }, entry.window === 'monthly' ? 'month' : entry.window === 'weekly' ? 'week' : entry.window),
                h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, `${left}% left`),
                reset ? h('span', { style: { opacity: .6 } }, `resets ${reset}`) : null)
            }),
            accountUsage.length > 0
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 } },
                accountUsage.map((account, index) => h('div', {
                  key: account.name ?? index,
                  title: accountUsage.map((item, at) => `ChatGPT ${at + 1}: ${windowLeft(item.usage, '5h') ?? '?'}% 5h, ${windowLeft(item.usage, 'weekly') ?? '?'}% week`).join('\n'),
                  style: { display: 'flex', gap: 8, opacity: .85 },
                },
                h('span', null, `ChatGPT ${index + 1}`),
                h('span', null, `5h ${windowLeft(account.usage, '5h') ?? '?'}% · wk ${windowLeft(account.usage, 'weekly') ?? '?'}%`))))
              : null,
            qwen !== undefined ? h('div', { title: qwen.note ?? '', style: { opacity: .75 } }, `Qwen: ${qwen.plan ?? 'plan'} · no usage API`) : null,
            subagents.slice(0, 6).map(entry => h('div', {
              key: entry.id,
              title: `${entry.label ?? entry.name}\n${entry.provider ?? '?'}/${entry.model ?? '?'}${entry.effort ? ` · ${entry.effort}` : ''}${entry.title ? `\n${entry.title}` : ''}`,
              style: { display: 'flex', gap: 8, opacity: .85, cursor: 'pointer' },
            },
            h('span', { style: { flex: 1 } }, entry.label ?? entry.name),
            h('span', { style: { fontFamily: C.mono, fontSize: 10 } }, `${entry.model ?? '?'}${entry.effort ? `·${entry.effort}` : ''}`))))
          : null)
    }

    /** Navigation glyph for the section. */
    function AccountsIcon({ size = 16, active }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { display: 'block', opacity: active ? 1 : 0.85 },
      },
      h('circle', { cx: 12, cy: 8, r: 3.2 }),
      h('path', { d: 'M4.5 20c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6' }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'accounts', order: 35, label: 'Accounts',
        }, AccountsSection))
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon', id: 'accounts', order: 35,
        }, AccountsIcon))
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'quota-dock', order: 20, label: 'Quota',
        }, QuotaDock))
      },
    }
  },
})