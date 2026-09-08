// bb-plugin-notify — фронтенд плагина уведомлений.
//
// Content script живёт всё время, пока открыто окно BB (а не только на своей
// вкладке). Он делает три вещи: показывает нативную плашку со звуком, держит
// метку на строке треда в сайдбаре, пока тред не открыли, и пишет счётчик
// ожидающих в заголовок окна. Плашка гаснет — метка и счётчик остаются.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";

interface NotifyConfig {
  enabled: boolean;
  sound: boolean;
  onIdle: boolean;
  onQuestion: boolean;
  onFailed: boolean;
  silentWhenVisible: boolean;
  voiceHotkey: string;
}

type NotifyKind = "idle" | "question" | "failed";

interface AttentionEntry {
  threadId: string;
  kind: NotifyKind;
  title: string;
  text: string | null;
  at: number;
}

type InboundSignal =
  | { type: "config"; config: NotifyConfig }
  | { type: "ping" }
  | { type: "attention"; entries: AttentionEntry[] }
  | ({ type: "notify" } & AttentionEntry);

const DEFAULT_CONFIG: NotifyConfig = {
  enabled: true,
  sound: true,
  onIdle: true,
  onQuestion: true,
  onFailed: true,
  silentWhenVisible: true,
  voiceHotkey: "mod+shift+d",
};

// Кнопка микрофона в композере BB. Подписи взяты из бандла самого BB, а не
// придуманы: старт — "Start voice input", стоп — "Stop and transcribe
// recording" (пока идёт расшифровка, у кнопки "Transcribing voice input" —
// в этот момент тумблер молчит, жать нечего).
const VOICE_START = 'button[aria-label="Start voice input"]';
const VOICE_STOP = 'button[aria-label="Stop and transcribe recording"]';

interface Hotkey {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/** "mod+shift+d" → структура. mod = ⌘ на маке, Ctrl на остальных. */
function parseHotkey(value: string): Hotkey | null {
  const parts = value
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1] ?? "";
  if (key === "") return null;
  const modifiers = parts.slice(0, -1);
  return {
    key,
    mod: modifiers.includes("mod") || modifiers.includes("cmd"),
    shift: modifiers.includes("shift"),
    alt: modifiers.includes("alt") || modifiers.includes("option"),
    ctrl: modifiers.includes("ctrl") || modifiers.includes("control"),
  };
}

function matchesHotkey(event: KeyboardEvent, hotkey: Hotkey): boolean {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (hotkey.mod !== mod) return false;
  if (hotkey.shift !== event.shiftKey) return false;
  if (hotkey.alt !== event.altKey) return false;
  if (hotkey.ctrl !== (isMac ? event.ctrlKey : false)) return false;
  // event.code даёт физическую клавишу: с ⌥ и с раскладкой event.key уезжает.
  const pressed = event.key.toLowerCase();
  const code = event.code.toLowerCase();
  return (
    pressed === hotkey.key ||
    code === hotkey.key ||
    code === `key${hotkey.key}` ||
    code === `digit${hotkey.key}`
  );
}

/** Тумблер: идёт запись — остановить, не идёт — начать. */
function toggleVoice(): boolean {
  const stop = document.querySelector<HTMLButtonElement>(VOICE_STOP);
  if (stop !== null) {
    stop.click();
    return true;
  }
  const start = document.querySelector<HTMLButtonElement>(VOICE_START);
  if (start !== null) {
    start.click();
    return true;
  }
  return false;
}

const HEADLINE: Record<NotifyKind, string> = {
  idle: "Работа завершена",
  question: "Агент ждёт ответа",
  failed: "Тред упал",
};

// Метка на строке треда — только там, где без тебя ничего не сдвинется.
// Законченный ход метки не получает: он и так виден непрочитанным тредом.
const ROW_STATUS: Record<
  NotifyKind,
  { icon: string; label: string; tone: "default" | "error" | "success" }
> = {
  idle: { icon: "Bell", label: "Агент закончил работу", tone: "default" },
  question: { icon: "Bell", label: "Агент ждёт ответа", tone: "error" },
  failed: { icon: "TriangleAlert", label: "Тред упал", tone: "error" },
};

/** Два коротких тона через WebAudio: не нужен файл и не нужен autoplay-жест. */
function playChime(kind: NotifyKind): void {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (Ctor === undefined) return;
  const context = new Ctor();
  const tones = kind === "failed" ? [420, 300] : [660, 880];
  tones.forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime + index * 0.16;
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.16);
  });
  window.setTimeout(() => void context.close(), 700);
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`/api/v1/plugins/notify/http/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

// ── Своя карточка внутри BB ──────────────────────────────────────────────
// Нативная плашка ОС требует разрешения, а его в удалённом окне
// (mac-bb.getbb.app) никто не выдавал — звук был, плашки не было. Карточка
// рисуется своим DOM, разрешений не требует и висит, пока её не закроют.
const CARD_HOST_ID = "bb-notify-cards";
const CARD_STYLE_ID = "bb-notify-cards-style";

const CARD_CSS = `
#${CARD_HOST_ID} {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 360px;
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  pointer-events: none;
}
#${CARD_HOST_ID} .bbn-card {
  pointer-events: auto;
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--popover, #1c1c1e);
  color: var(--popover-foreground, #f5f5f7);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  cursor: pointer;
}
#${CARD_HOST_ID} .bbn-card.bbn-question { border-left: 3px solid #e5484d; }
#${CARD_HOST_ID} .bbn-card.bbn-failed { border-left: 3px solid #e5484d; }
#${CARD_HOST_ID} .bbn-card.bbn-idle { border-left: 3px solid #30a46c; }
#${CARD_HOST_ID} .bbn-body { min-width: 0; flex: 1; }
#${CARD_HOST_ID} .bbn-head { font-weight: 600; margin-bottom: 2px; }
#${CARD_HOST_ID} .bbn-title { opacity: 0.85; overflow-wrap: anywhere; }
#${CARD_HOST_ID} .bbn-text { opacity: 0.6; margin-top: 4px; overflow-wrap: anywhere; }
#${CARD_HOST_ID} .bbn-close {
  pointer-events: auto;
  border: 0;
  background: transparent;
  color: inherit;
  opacity: 0.5;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  padding: 2px 4px;
}
#${CARD_HOST_ID} .bbn-close:hover { opacity: 1; }
`;

interface CardDeck {
  show: (entry: AttentionEntry, onOpen: (threadId: string) => void) => void;
  /** Закрывает открытые карточки question/failed, чей тред больше не в
   * списке "ждут внимания" (прочитан, отвечен, тред активен/архивирован/
   * удалён) — карточка не должна пережить причину, по которой возникла.
   * idle-карточки сюда не попадают: они не живут в этом реестре, у них
   * свой таймер ниже. */
  prune: (activeThreadIds: ReadonlySet<string>) => void;
  destroy: () => void;
}

function createCardDeck(): CardDeck {
  const style = document.createElement("style");
  style.id = CARD_STYLE_ID;
  style.textContent = CARD_CSS;
  document.head.append(style);

  const host = document.createElement("div");
  host.id = CARD_HOST_ID;
  document.body.append(host);

  // idle — единственный сигнал без записи на сервере (see server.ts:
  // "kind !== idle" в attention), поэтому его карточка не может закрыться
  // реакцией на attention-реестр — закрывается сама по таймеру, как и
  // обещает комментарий в server.ts ("Плашка гаснет за секунды").
  const IDLE_LIFETIME_MS = 8000;
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    show(entry, onOpen) {
      // Один тред — одна карточка: повторный сигнал обновляет её, а не плодит.
      host
        .querySelectorAll(`[data-thread="${CSS.escape(entry.threadId)}"]`)
        .forEach((node) => node.remove());
      const staleTimer = idleTimers.get(entry.threadId);
      if (staleTimer !== undefined) {
        clearTimeout(staleTimer);
        idleTimers.delete(entry.threadId);
      }

      const card = document.createElement("div");
      card.className = `bbn-card bbn-${entry.kind}`;
      card.dataset.thread = entry.threadId;
      card.dataset.kind = entry.kind;

      const body = document.createElement("div");
      body.className = "bbn-body";

      const head = document.createElement("div");
      head.className = "bbn-head";
      head.textContent = HEADLINE[entry.kind];

      const title = document.createElement("div");
      title.className = "bbn-title";
      title.textContent = entry.title;

      body.append(head, title);

      if (entry.text !== null && entry.text !== "") {
        const text = document.createElement("div");
        text.className = "bbn-text";
        text.textContent = entry.text;
        body.append(text);
      }

      const close = document.createElement("button");
      close.type = "button";
      close.className = "bbn-close";
      close.textContent = "✕";
      close.setAttribute("aria-label", "Закрыть уведомление");
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        card.remove();
      });

      card.addEventListener("click", () => {
        card.remove();
        if (entry.threadId !== "test") onOpen(entry.threadId);
      });

      card.append(body, close);
      host.prepend(card);

      // Больше пяти карточек — это уже свалка: самые старые уходят.
      while (host.children.length > 5) host.lastElementChild?.remove();

      if (entry.kind === "idle") {
        idleTimers.set(
          entry.threadId,
          setTimeout(() => {
            card.remove();
            idleTimers.delete(entry.threadId);
          }, IDLE_LIFETIME_MS),
        );
      }
    },
    prune(activeThreadIds) {
      host
        .querySelectorAll<HTMLElement>(".bbn-card")
        .forEach((node) => {
          const threadId = node.dataset.thread;
          // idle не участвует в этом реестре вовсе — трогать его тут нечего,
          // "test" — карточка ручной проверки, её тоже не закрываем реакцией.
          if (
            threadId === undefined ||
            threadId === "test" ||
            node.dataset.kind === "idle"
          ) {
            return;
          }
          if (!activeThreadIds.has(threadId)) node.remove();
        });
    },
    destroy() {
      for (const timer of idleTimers.values()) clearTimeout(timer);
      idleTimers.clear();
      host.remove();
      style.remove();
    },
  };
}

/** Тред уже открыт в этом окне? Пропускает главный тред (по URL) и тред,
 * открытый во второй панели (сплит) — BB метит такую строку сайдбара
 * классом bb-sidebar-open-in-split-row, а не aria-current (тот BB не ставит
 * вовсе — старая проверка была мёртвым кодом). */
function isThreadOnScreen(threadId: string): boolean {
  if (window.location.pathname.includes(threadId)) return true;
  const link = document.querySelector(
    `[data-sidebar-thread-id="${CSS.escape(threadId)}"]`,
  );
  for (let node = link; node !== null; node = node.parentElement) {
    if (
      typeof node.className === "string" &&
      node.className.includes("bb-sidebar-open-in-split-row")
    ) {
      return true;
    }
  }
  return false;
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "notify-listener",
    mount({ pluginId, signal, experimental_setThreadRowStatus }) {
      let config = DEFAULT_CONFIG;
      let marked: string[] = [];

      // Заголовок окна: «(2) …» видно в доке и на вкладке, даже когда BB свёрнут.
      const baseTitle = () => document.title.replace(/^\(\d+\)\s*/, "");
      let ownTitle = "";
      const applyBadge = (count: number) => {
        const next =
          count === 0 ? baseTitle() : `(${count}) ${baseTitle()}`;
        if (document.title === next) return;
        ownTitle = next;
        document.title = next;
      };
      // BB переписывает заголовок при смене треда — возвращаем бейдж на место.
      const titleNode = document.querySelector("title");
      const titleWatcher =
        titleNode === null
          ? null
          : new MutationObserver(() => {
              if (document.title === ownTitle) return;
              applyBadge(marked.length);
            });
      titleWatcher?.observe(titleNode as Node, {
        childList: true,
        characterData: true,
        subtree: true,
      });

      const applyAttention = (entries: AttentionEntry[]) => {
        const next = entries.map((entry) => entry.threadId);
        const activeThreadIds = new Set(next);
        for (const threadId of marked) {
          if (next.includes(threadId)) continue;
          experimental_setThreadRowStatus?.(threadId, null);
        }
        for (const entry of entries) {
          const status = ROW_STATUS[entry.kind];
          experimental_setThreadRowStatus?.(entry.threadId, {
            icon: status.icon,
            label: status.label,
            tone: status.tone,
          });
        }
        marked = next;
        applyBadge(next.length);

        // Тред прочитан/отвечен/стал активным (бэкенд уже это решил — см.
        // server.ts pending-interaction-watch) — плашка и системное
        // уведомление про него больше не нужны, откуда бы ты его ни открыл.
        cards.prune(activeThreadIds);
        for (const [threadId, notification] of liveNotifications) {
          if (activeThreadIds.has(threadId)) continue;
          notification.close();
          liveNotifications.delete(threadId);
        }
      };

      const openThread = (threadId: string) => {
        window.focus();
        void post("open", { threadId });
      };

      const cards = createCardDeck();
      // Нативные плашки ОС живут своей жизнью (requireInteraction: true —
      // висят до клика) — без этой карты их некому закрыть, когда тред
      // прочитан не кликом по самой плашке (например, открыт из сайдбара).
      const liveNotifications = new Map<string, Notification>();

      const onKeyDown = (event: KeyboardEvent) => {
        if (event.repeat) return;
        const hotkey = parseHotkey(config.voiceHotkey ?? "");
        if (hotkey === null) return;
        if (!matchesHotkey(event, hotkey)) return;
        event.preventDefault();
        event.stopPropagation();
        toggleVoice();
      };
      // capture: композер BB перехватывает клавиши раньше — успеваем первыми.
      window.addEventListener("keydown", onKeyDown, { capture: true });

      const source = new EventSource(`/api/v1/plugins/${pluginId}/http/events`);

      source.addEventListener("message", (event: MessageEvent<string>) => {
        let payload: InboundSignal;
        try {
          payload = JSON.parse(event.data) as InboundSignal;
        } catch {
          return;
        }
        if (payload.type === "config") {
          config = payload.config;
          return;
        }
        if (payload.type === "attention") {
          applyAttention(payload.entries);
          return;
        }
        if (payload.type !== "notify") return;

        const { kind, threadId, title, text } = payload;
        if (!config.enabled) return;
        if (
          config.silentWhenVisible &&
          threadId !== "test" &&
          document.hasFocus() &&
          isThreadOnScreen(threadId)
        ) {
          return;
        }

        if (config.sound) playChime(kind);

        // Один сигнал на событие, а не два. Раньше карточка рисовалась ВСЕГДА,
        // а нативная плашка добавлялась сверху, если ОС разрешила, — и в окне
        // с выданным permission приходило два уведомления об одном событии:
        // системное в правом верхнем углу и своя карточка в правом нижнем.
        // Основной канал — нативная плашка: она видна, когда bb свёрнут, а след
        // события остаётся меткой на строке треда в сайдбаре. Своя карточка —
        // фолбэк для окон без разрешения (удалённое mac-bb.getbb.app), там она
        // единственное, что видно, кроме звука.
        const canNotify =
          typeof Notification !== "undefined" &&
          Notification.permission === "granted";

        if (!canNotify) {
          cards.show(payload, openThread);
          return;
        }

        const notification = new Notification(`${HEADLINE[kind]}: ${title}`, {
          body: text ?? "",
          tag: `bb-notify-${threadId}`,
          // Плашка висит до клика там, где браузер это поддерживает; там, где
          // нет (баннеры macOS) — след остаётся меткой в сайдбаре. Закрыть её
          // раньше срока умеет applyAttention выше — по тому же threadId.
          requireInteraction: true,
          renotify: true,
          silent: true,
        } as NotificationOptions);
        if (threadId !== "test") liveNotifications.set(threadId, notification);
        notification.onclick = () => {
          if (threadId !== "test") {
            openThread(threadId);
            liveNotifications.delete(threadId);
          } else {
            window.focus();
          }
          notification.close();
        };
      });

      const close = () => {
        cards.destroy();
        window.removeEventListener("keydown", onKeyDown, { capture: true });
        source.close();
        titleWatcher?.disconnect();
        for (const threadId of marked) {
          experimental_setThreadRowStatus?.(threadId, null);
        }
        marked = [];
        applyBadge(0);
        liveNotifications.clear();
      };
      signal.addEventListener("abort", close, { once: true });
      return close;
    },
  });

  app.slots.settingsSection({
    id: "notify",
    title: "Уведомления о работе агентов",
    description:
      "Плашка ОС со звуком, метка на строке треда в сайдбаре и счётчик в заголовке окна — когда агент закончил работу, ждёт ответа или упал.",
    component: NotifySettings,
  });
});

function NotifySettings() {
  const [permission, setPermission] = useState<NotificationPermission | "none">(
    typeof Notification === "undefined" ? "none" : Notification.permission,
  );
  const [entries, setEntries] = useState<AttentionEntry[]>([]);
  const [result, setResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/plugins/notify/http/attention");
      const payload = (await response.json()) as { entries?: AttentionEntry[] };
      setEntries(payload.entries ?? []);
    } catch {
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ask = useCallback(async () => {
    if (typeof Notification === "undefined") {
      setResult("Это окно не умеет показывать системные уведомления.");
      return;
    }
    setPermission(await Notification.requestPermission());
  }, []);

  const test = useCallback(async () => {
    setResult(null);
    try {
      const response = await post("test", {});
      const payload = (await response.json()) as {
        ok?: boolean;
        clients?: number;
      };
      setResult(
        payload.ok === true
          ? `Сигнал ушёл в ${payload.clients ?? 0} окно(окон) BB.`
          : "Бэкенд ответил отказом.",
      );
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const clearAll = useCallback(async () => {
    await post("dismiss", {});
    await refresh();
  }, [refresh]);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">
        Разрешение на плашки:{" "}
        <span className="font-medium text-foreground">
          {permission === "granted"
            ? "выдано"
            : permission === "denied"
              ? "запрещено в системе или браузере"
              : permission === "none"
                ? "недоступно в этом окне"
                : "не запрошено"}
        </span>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void ask()}
          disabled={permission === "granted" || permission === "none"}
        >
          Разрешить уведомления
        </Button>
        <Button variant="outline" size="sm" onClick={() => void test()}>
          Проверить
        </Button>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          Обновить список
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setResult(
              toggleVoice()
                ? "Кнопка микрофона найдена и нажата."
                : "Кнопки микрофона нет на экране: открой тред с полем ввода.",
            );
          }}
        >
          Проверить микрофон
        </Button>
      </div>
      {result !== null && <p className="text-muted-foreground">{result}</p>}
      <div className="flex flex-col gap-1">
        <p className="font-medium">Ждут внимания: {entries.length}</p>
        {entries.map((entry) => (
          <button
            key={entry.threadId}
            type="button"
            className="text-left text-muted-foreground hover:text-foreground"
            onClick={() => {
              void post("open", { threadId: entry.threadId }).then(refresh);
            }}
          >
            · {HEADLINE[entry.kind]} — {entry.title}
          </button>
        ))}
        {entries.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => void clearAll()}
          >
            Снять все метки
          </Button>
        )}
      </div>
    </div>
  );
}