// "Developer: Show activity log" — the last background runs (index passes, incremental index
// updates, git status …) with what triggered them, how long they took and how much they touched.
import { app } from './app';
import { activityLog } from './activity';
import './overlays.css'; // dialog base (.se-actlog resizes it)
import './activity-log.css';

function ActivityLog() {
  const close = () => (app.overlay.value = null);
  const rows = [...activityLog.value].reverse();
  const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour12: false });
  return (
    <div class="se-overlay se-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="se-dialog se-actlog" role="dialog" aria-modal="true" aria-label="Activity log" tabIndex={-1} ref={(el) => el?.focus()} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), close())}>
        <h2 class="se-dialog-title">Activity log</h2>
        <p class="se-dialog-msg">Background work since launch (newest first, last 200).</p>
        <div class="se-actlog-list">
          {rows.length === 0 ? (
            <p class="se-dialog-msg">Nothing yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>What</th>
                  <th>Why</th>
                  <th class="n">ms</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr data-kind={r.kind}>
                    <td>{time(r.at)}</td>
                    <td>{r.kind}</td>
                    <td>{r.trigger}</td>
                    <td class="n">{r.ms.toLocaleString()}</td>
                    <td>{r.detail ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div class="se-dialog-buttons">
          <button class="se-btn primary" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export function openActivityLog() {
  app.overlay.value = ActivityLog;
}
