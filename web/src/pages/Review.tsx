import { useState } from 'react';
import { BarsByName, Columns, Hero, StatTile } from '../components/charts';
import { Button, Card, Empty } from '../components/ui';
import { useRangeStats, useToday } from '../hooks';
import { addDays, dayLabel, duration, hourLabel, todayKey } from '../lib/format';
import { seriesColor } from '../lib/palette';

const RANGES = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

export function ReviewPage({ dark }: { dark: boolean }) {
  const { data: todayInfo } = useToday();
  const [days, setDays] = useState(7);
  const to = todayInfo?.today ?? todayKey();
  const from = addDays(to, -(days - 1));
  const { data: stats, isLoading } = useRangeStats(from, to);

  if (isLoading || !stats) return <p className="text-sm text-muted">Loading…</p>;

  const hasData = stats.totalFocusSeconds > 0;

  return (
    <div className="space-y-4">
      {/* Filters sit in one row above the charts. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Review</h1>
          <p className="text-xs text-muted">
            {dayLabel(from)} – {dayLabel(to)}
          </p>
        </div>
        <div className="flex gap-1.5">
          {RANGES.map((r) => (
            <Button
              key={r.days}
              size="sm"
              variant={days === r.days ? 'primary' : 'default'}
              onClick={() => setDays(r.days)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      {!hasData ? (
        <Card>
          <Empty>No focus time logged in this window yet.</Empty>
        </Card>
      ) : (
        <>
          <Card>
            <div className="grid gap-6 md:grid-cols-[auto_minmax(0,1fr)] md:items-center">
              <Hero
                label="Total focused"
                value={duration(stats.totalFocusSeconds)}
                detail={`${stats.totalBlocks} blocks across ${stats.activeDays} day${
                  stats.activeDays === 1 ? '' : 's'
                }`}
              />
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <StatTile
                  label="Per active day"
                  value={duration(stats.avgSecondsPerActiveDay)}
                  detail="average"
                />
                <StatTile
                  label="Focus score"
                  value={stats.avgFocusScore ?? '—'}
                  detail="0–100 average"
                />
                <StatTile
                  label="Block length"
                  value={
                    stats.totalBlocks
                      ? duration(Math.round(stats.totalFocusSeconds / stats.totalBlocks))
                      : '—'
                  }
                  detail="average"
                />
              </div>
            </div>
          </Card>

          <Card title="Focused time per day" subtitle="Worked time, excluding breaks and discards">
            <Columns
              columns={stats.days.map((d) => ({
                key: d.day,
                label: dayLabel(d.day, { weekday: days <= 14 }),
                seconds: d.focusSeconds,
                tooltip: (
                  <>
                    {dayLabel(d.day, { weekday: true })} · {duration(d.focusSeconds)}
                    {d.blocks > 0 && ` · ${d.blocks} block${d.blocks === 1 ? '' : 's'}`}
                    {d.avgFocusScore != null && ` · focus ${d.avgFocusScore}`}
                  </>
                ),
              }))}
              height={160}
              emptyText="No focus time in this window."
              tableLabel="Day"
              labelEvery={days <= 7 ? 1 : days <= 30 ? 5 : 15}
            />
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Where the time went" subtitle="By project, biggest first">
              <BarsByName
                bars={stats.byProject.map((p) => ({
                  key: String(p.projectId ?? 'none'),
                  name: p.name,
                  color: seriesColor(p.color, dark),
                  seconds: p.seconds,
                  detail: `${p.share}%`,
                }))}
                emptyText="No focus time in this window."
              />
            </Card>

            <Card
              title="Your best hours"
              subtitle="Worked time by hour of day — plan the hard work here"
            >
              <Columns
                columns={stats.byHour.map((h) => ({
                  key: String(h.hour),
                  label: hourLabel(h.hour),
                  seconds: h.seconds,
                  tooltip: `${hourLabel(h.hour)} · ${duration(h.seconds)} over ${days} days`,
                }))}
                height={160}
                emptyText="No focus time in this window."
                tableLabel="Hour"
                labelEvery={3}
              />
            </Card>
          </div>

          <Card title="Project detail" subtitle="Time, share and how focused it felt">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-xs">
                <thead className="text-muted">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">Project</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Time</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Share</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Blocks</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Avg block</th>
                    <th className="py-1.5 text-right font-medium">Focus score</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byProject.map((p) => (
                    <tr key={p.projectId ?? 'none'} className="border-t border-hairline">
                      <td className="py-2 pr-3">
                        <span className="flex items-center gap-1.5 text-ink">
                          <span
                            aria-hidden="true"
                            className="inline-block size-2.5 shrink-0 rounded-full"
                            style={{ background: seriesColor(p.color, dark) }}
                          />
                          {p.name}
                        </span>
                      </td>
                      <td className="tabular py-2 pr-3 text-right text-ink-2">
                        {duration(p.seconds)}
                      </td>
                      <td className="tabular py-2 pr-3 text-right text-ink-2">{p.share}%</td>
                      <td className="tabular py-2 pr-3 text-right text-ink-2">{p.blocks}</td>
                      <td className="tabular py-2 pr-3 text-right text-ink-2">
                        {duration(Math.round(p.seconds / Math.max(1, p.blocks)))}
                      </td>
                      <td className="tabular py-2 text-right text-ink-2">
                        {p.avgFocusScore ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
