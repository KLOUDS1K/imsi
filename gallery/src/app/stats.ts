/**
 * The owner's stats page.
 *
 * Part of the management bundle, so a visitor never downloads it. It only ever
 * reads counters — there is nothing per-person to show, because nothing
 * per-person is stored.
 */
import type { StatsReport } from '../shared/types'
import { formatTimestamp, plural } from '../shared/types'
import { api } from './api'
import { state, update } from './state'
import { el } from './ui'
import { icon } from './icons'

export async function loadStats(): Promise<void> {
  update({ statsOpen: true, search: null, loading: true, errorText: null })
  try {
    const report = await api.stats()
    update({ stats: report, loading: false })
  } catch (err) {
    update({
      loading: false,
      errorText: err instanceof Error ? err.message : 'Could not load the stats',
    })
  }
}

const nf = new Intl.NumberFormat('en-US')

function tile(label: string, value: number, note?: string): HTMLElement {
  return el('div', { class: 'stat' }, [
    el('span', { class: 'stat__label', text: label }),
    el('span', { class: 'stat__value', text: nf.format(value) }),
    note ? el('span', { class: 'stat__note', text: note }) : null,
  ])
}

/**
 * Thirty days of bars. Drawn with preserveAspectRatio="none" so the chart
 * stretches to whatever width the pane gives it — safe here because every mark
 * is a rectangle; the labels are HTML underneath, where stretching them would
 * have shown.
 */
function chart(days: StatsReport['daily']): HTMLElement {
  const peak = Math.max(1, ...days.map((d) => Math.max(d.visits, d.downloads)))
  const step = 300 / days.length
  const parts: string[] = []

  days.forEach((day, i) => {
    const x = i * step
    const visits = (day.visits / peak) * 92
    const downloads = (day.downloads / peak) * 92
    if (day.visits > 0) {
      parts.push(
        `<rect x="${(x + step * 0.12).toFixed(2)}" y="${(96 - visits).toFixed(2)}" ` +
          `width="${(step * 0.42).toFixed(2)}" height="${Math.max(visits, 1).toFixed(2)}" ` +
          `rx="0.6" class="chart__visits"/>`,
      )
    }
    if (day.downloads > 0) {
      parts.push(
        `<rect x="${(x + step * 0.5).toFixed(2)}" y="${(96 - downloads).toFixed(2)}" ` +
          `width="${(step * 0.42).toFixed(2)}" height="${Math.max(downloads, 1).toFixed(2)}" ` +
          `rx="0.6" class="chart__downloads"/>`,
      )
    }
  })

  const first = days[0]?.day ?? ''
  const last = days[days.length - 1]?.day ?? ''

  return el('div', { class: 'chart' }, [
    el('div', { class: 'chart__head' }, [
      el('h3', { class: 'section__title', text: 'Last 30 days' }),
      el('div', { class: 'chart__legend' }, [
        el('span', { class: 'chart__key chart__key--visits', text: 'Visits' }),
        el('span', { class: 'chart__key chart__key--downloads', text: 'Downloads' }),
      ]),
    ]),
    el('div', {
      class: 'chart__plot',
      html:
        `<svg viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden="true">` +
        `<line x1="0" y1="96.5" x2="300" y2="96.5" class="chart__axis"/>` +
        parts.join('') +
        `</svg>`,
    }),
    el('div', { class: 'chart__scale' }, [
      el('span', { text: first }),
      el('span', { text: `peak ${nf.format(peak)}` }),
      el('span', { text: last }),
    ]),
  ])
}

function rankList(
  title: string,
  empty: string,
  rows: { name: string; sub?: string; value: number }[],
): HTMLElement {
  const body = rows.length
    ? el(
        'ol',
        { class: 'ranks' },
        rows.map((row, i) =>
          el('li', { class: 'rank' }, [
            el('span', { class: 'rank__n', text: String(i + 1) }),
            el('span', { class: 'rank__name' }, [
              el('span', { class: 'rank__title', text: row.name, title: row.name }),
              row.sub ? el('span', { class: 'rank__sub', text: row.sub }) : null,
            ]),
            el('span', { class: 'rank__value', text: nf.format(row.value) }),
          ]),
        ),
      )
    : el('p', { class: 'ranks__empty', text: empty })

  return el('section', { class: 'section' }, [
    el('h3', { class: 'section__title', text: title }),
    body,
  ])
}

export function statsPanel(): HTMLElement {
  const report = state.stats

  const head = el('header', { class: 'pane__head' }, [
    el('div', { class: 'pane__titles' }, [
      el('h1', { class: 'pane__title', text: 'Stats' }),
      el('p', {
        class: 'pane__note',
        text: report?.since
          ? `Counting since ${formatTimestamp(report.since)}. Your own visits are not counted.`
          : 'Nothing counted yet. Your own visits are never counted.',
      }),
    ]),
  ])

  if (!report) {
    return el('div', { class: 'stats' }, [
      head,
      el('p', { class: 'state', text: state.loading ? 'Loading' : '' }),
    ])
  }

  return el('div', { class: 'stats' }, [
    head,
    el('div', { class: 'stats__tiles' }, [
      tile('Visitors', report.visitors, 'distinct browsers'),
      tile('Visits', report.visits, 'times the site was opened'),
      tile('Folder views', report.views, 'folders opened'),
      tile('Downloads', report.downloads, 'originals taken'),
    ]),
    chart(report.daily),
    el('div', { class: 'stats__lists' }, [
      rankList(
        'Most viewed folders',
        'No folder has been opened yet.',
        report.topFolders.map((f) => ({ name: f.name, value: f.views })),
      ),
      rankList(
        'Most downloaded photos',
        'Nothing has been downloaded yet.',
        report.topPhotos.map((p) => ({ name: p.name, sub: p.folder, value: p.downloads })),
      ),
    ]),
    el('p', { class: 'stats__foot' }, [
      el('span', { class: 'stats__foot-icon', html: icon('info') }),
      el('span', {
        text:
          'Counts come from a random id in a first-party cookie — no addresses, ' +
          'no browser strings, nothing that identifies anyone. ' +
          `${plural(report.topPhotos.length, 'photo')} downloaded at least once.`,
      }),
    ]),
  ])
}
