/** Phone notifications through ntfy (https://ntfy.sh): a key that stops working or comes back, and the rolling
 * 24-hour spending cap. Each change is sent once: alert_state records the last state notified, and only the
 * instance whose conditional write succeeds sends. Everything here is best effort and never blocks a request. */
import { backends, spendCap, type Env } from './shared';

type CapLevel = 'ok' | 'warn' | 'hit';
const CAP_WARN_SHARE = 0.8;

interface Notice { title: string; message: string; priority: 'default' | 'high' | 'urgent'; tags: string[] }

export const alertsEnabled = (env: Env): boolean => !!env.NTFY_TOPIC?.trim();

export async function notify(env: Env, n: Notice): Promise<boolean> {
  const topic = env.NTFY_TOPIC?.trim();
  if (!topic) return false;
  try {
    const r = await fetch((env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, ''), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic, title: n.title, message: n.message, priority: n.priority === 'urgent' ? 5 : n.priority === 'high' ? 4 : 3,
        tags: n.tags, click: env.PUBLIC_URL ? `${env.PUBLIC_URL.replace(/\/$/, '')}/` : undefined,
      }),
    });
    await r.body?.cancel();
    return r.ok;
  } catch {
    return false;
  }
}

/** Notifies when key `slot` becomes unusable (down) or works again (up), once per change. */
export async function keyAlert(env: Env, slot: number, down: boolean, reason: string): Promise<void> {
  const db = env.USAGE_DB;
  if (!db || !alertsEnabled(env)) return;
  const now = new Date().toISOString();
  try {
    const changed = down
      ? await db.prepare(`INSERT INTO alert_state (name, value, updated_at) VALUES (?1, 'down', ?2)
            ON CONFLICT (name) DO UPDATE SET value = 'down', updated_at = ?2 WHERE alert_state.value != 'down'`)
          .bind(`key:${slot}`, now).run()
      // Absent means it never went down, so there is nothing to announce.
      : await db.prepare(`UPDATE alert_state SET value = 'ok', updated_at = ?2 WHERE name = ?1 AND value = 'down'`)
          .bind(`key:${slot}`, now).run();
    if (!changed.meta.changes) return;
    const total = backends(env, Date.now()).length;
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM alert_state WHERE name LIKE 'key:%' AND value = 'down'`)
      .first<{ n: number }>();
    const usable = Math.max(0, total - (row?.n ?? 0));
    if (down) {
      await notify(env, {
        title: usable === 0 ? '所有 Claude key 都不可用' : `Claude Key ${slot} 不可用`,
        message: `Key ${slot}: ${reason}\n${usable === 0 ? '经过 gateway 的请求现在都会失败。' : `请求已自动转到其他 key（还有 ${usable}/${total} 个可用）。`}`,
        priority: usable === 0 ? 'urgent' : 'high',
        tags: ['rotating_light'],
      });
    } else {
      await notify(env, {
        title: `Claude Key ${slot} 恢复正常`,
        message: `Key ${slot} 又可以用了（${usable}/${total} 个 key 可用）。${reason ? `\n${reason}` : ''}`,
        priority: 'default',
        tags: ['white_check_mark'],
      });
    }
  } catch {
    // Best effort.
  }
}

/** Compares spending in the rolling 24 hours with the cap and notifies on 80%, on reaching it, and when it lifts. */
export async function capAlert(env: Env, spent: number): Promise<void> {
  const db = env.USAGE_DB;
  const cap = spendCap(env);
  if (!db || !cap || !alertsEnabled(env)) return;
  const level: CapLevel = spent >= cap ? 'hit' : spent >= cap * CAP_WARN_SHARE ? 'warn' : 'ok';
  try {
    const row = await db.prepare(`SELECT value FROM alert_state WHERE name = 'cap'`).first<{ value: CapLevel }>();
    const previous: CapLevel = row?.value ?? 'ok';
    if (previous === level) return;
    // Compare-and-set, so only one instance announces this change.
    const res = await db.prepare(`INSERT INTO alert_state (name, value, updated_at) VALUES ('cap', ?1, ?2)
        ON CONFLICT (name) DO UPDATE SET value = ?1, updated_at = ?2 WHERE alert_state.value = ?3`)
      .bind(level, new Date().toISOString(), previous).run();
    if (!res.meta.changes) return;
    const money = (v: number) => `$${v.toFixed(2)}`;
    if (level === 'hit') {
      await notify(env, {
        title: 'Claude gateway 已达到每日花费上限',
        message: `过去 24 小时花了 ${money(spent)}（上限 ${money(cap)}）。新请求暂停，等较早的花费移出 24 小时窗口后自动恢复。`,
        priority: 'urgent', tags: ['no_entry'],
      });
    } else if (level === 'warn' && previous === 'ok') {
      await notify(env, {
        title: 'Claude gateway 花费接近每日上限',
        message: `过去 24 小时花了 ${money(spent)}，已到上限 ${money(cap)} 的 ${Math.round((spent / cap) * 100)}%。`,
        priority: 'high', tags: ['warning'],
      });
    } else if (previous === 'hit') {
      await notify(env, {
        title: 'Claude gateway 花费上限已解除',
        message: `过去 24 小时花费回到 ${money(spent)}（上限 ${money(cap)}），请求已恢复。`,
        priority: 'default', tags: ['white_check_mark'],
      });
    }
  } catch {
    // Best effort.
  }
}
