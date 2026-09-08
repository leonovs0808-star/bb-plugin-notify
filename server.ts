// bb-plugin-notify — бэкенд плагина уведомлений.
//
// Ловит три события и рассылает их всем открытым окнам BB по SSE:
//   idle     — агент закончил ход;
//   question — агент ждёт ответа (у треда появился pending interaction);
//   failed   — тред упал.
// Плашка гаснет за секунды, поэтому сигнал не одноразовый: тред попадает в
// реестр «ждут внимания», фронтенд держит по нему метку на строке треда, и
// реестр переживает перезагрузку окна. Снимается при открытии треда.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type NotifyKind = "idle" | "question" | "failed";

interface NotifyConfig {
  enabled: boolean;
  sound: boolean;
  onIdle: boolean;
  onQuestion: boolean;
  onFailed: boolean;
  silentWhenVisible: boolean;
  voiceHotkey: string;
}

interface AttentionEntry {
  threadId: string;
  kind: NotifyKind;
  title: string;
  text: string | null;
  at: number;
}

type OutboundSignal =
  | { type: "config"; config: NotifyConfig }
  | { type: "ping" }
  | { type: "attention"; entries: AttentionEntry[] }
  | ({ type: "notify" } & AttentionEntry);

/** Заголовок треда для плашки: имя, иначе первая строка первого сообщения. */
function threadTitle(thread: {
  title: string | null;
  titleFallback: string | null;
}): string {
  const name = thread.title ?? thread.titleFallback ?? "";
  const trimmed = name.trim();
  return trimmed === "" ? "Тред без названия" : clamp(trimmed, 70);
}

/** Одна строка, не длиннее limit: тело плашки в ОС всё равно обрежется. */
function clamp(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Уведомления включены",
      default: true,
    },
    sound: { type: "boolean", label: "Звук", default: true },
    onIdle: {
      type: "boolean",
      label: "Когда агент закончил работу",
      default: true,
    },
    onQuestion: {
      type: "boolean",
      label: "Когда агент ждёт твоего ответа",
      default: true,
    },
    onFailed: {
      type: "boolean",
      label: "Когда тред упал с ошибкой",
      default: true,
    },
    silentWhenVisible: {
      type: "boolean",
      label: "Молчать, если этот тред открыт и окно в фокусе",
      default: true,
    },
    voiceHotkey: {
      type: "string",
      label:
        "Клавиша микрофона (тумблер): например mod+shift+d, alt+v, f5. Пусто — выключить",
      default: "mod+shift+d",
    },
  });

  let config: NotifyConfig = await settings.get();
  settings.onChange((next) => {
    config = next;
    broadcast({ type: "config", config });
  });

  // ── SSE-хаб: одно соединение на каждое открытое окно BB ──────────────────
  const encoder = new TextEncoder();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

  function push(
    controller: ReadableStreamDefaultController<Uint8Array>,
    signal: OutboundSignal,
  ): void {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(signal)}\n\n`));
  }

  function broadcast(signal: OutboundSignal): void {
    for (const controller of [...clients]) {
      try {
        push(controller, signal);
      } catch {
        clients.delete(controller);
      }
    }
  }

  // ── Реестр «ждут внимания» ───────────────────────────────────────────────
  const attention = new Map<string, AttentionEntry>();

  function attentionList(): AttentionEntry[] {
    return [...attention.values()].sort((left, right) => right.at - left.at);
  }

  function publishAttention(): void {
    broadcast({ type: "attention", entries: attentionList() });
  }

  function clearAttention(threadId: string): void {
    if (!attention.delete(threadId)) return;
    publishAttention();
  }

  function notify(
    kind: NotifyKind,
    thread: { id: string; title: string | null; titleFallback: string | null },
    text: string | null,
  ): void {
    if (!config.enabled) return;
    if (kind === "idle" && !config.onIdle) return;
    if (kind === "question" && !config.onQuestion) return;
    if (kind === "failed" && !config.onFailed) return;
    const entry: AttentionEntry = {
      threadId: thread.id,
      kind,
      title: threadTitle(thread),
      text: text === null ? null : clamp(text, 160),
      at: Date.now(),
    };
    // Метку на строке треда получают только те два случая, где без тебя ничего
    // не сдвинется. Законченный ход — плашка и звук в момент события: галочка
    // на каждом треде подряд не сообщает ничего и висит вечно.
    if (kind !== "idle") attention.set(entry.threadId, entry);
    bb.log.info(
      `сигнал «${kind}» по треду ${thread.id} → окон BB на связи: ${clients.size}`,
    );
    broadcast({ type: "notify", ...entry });
    publishAttention();
  }

  bb.http.route("GET", "/events", () => {
    let own: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        own = controller;
        clients.add(controller);
        push(controller, { type: "config", config });
        push(controller, { type: "attention", entries: attentionList() });
      },
      cancel() {
        if (own !== null) clients.delete(own);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });

  // Клик по плашке. Тред открывает сам BB — DOM сайдбара для этого не годится:
  // строки нужного треда в нём может не быть вовсе.
  bb.http.route("POST", "/open", async (context) => {
    let threadId: unknown;
    try {
      ({ threadId } = (await context.req.json()) as { threadId?: unknown });
    } catch {
      return Response.json(
        { ok: false, error: "invalid_json" },
        { status: 400 },
      );
    }
    if (typeof threadId !== "string" || threadId === "") {
      return Response.json({ ok: false, error: "no_thread" }, { status: 400 });
    }
    clearAttention(threadId);
    try {
      await bb.sdk.threads.open({ threadId, file: null });
    } catch (error) {
      bb.log.warn(`не смог открыть тред ${threadId}: ${String(error)}`);
      return Response.json({ ok: false, error: String(error) }, { status: 500 });
    }
    return Response.json({ ok: true });
  });

  // Метку снимает и сам пользователь — из списка «ждут внимания».
  bb.http.route("POST", "/dismiss", async (context) => {
    let threadId: unknown;
    try {
      ({ threadId } = (await context.req.json()) as { threadId?: unknown });
    } catch {
      return Response.json(
        { ok: false, error: "invalid_json" },
        { status: 400 },
      );
    }
    if (typeof threadId === "string" && threadId !== "") {
      clearAttention(threadId);
    } else {
      attention.clear();
      publishAttention();
    }
    return Response.json({ ok: true });
  });

  bb.http.route("GET", "/attention", () =>
    Response.json({ entries: attentionList() }),
  );

  // Кнопка «Проверить» в настройках: гоняет сигнал по всей цепи, а не рисует
  // плашку локально — иначе проверка не доказывает, что бэкенд достаёт до окна.
  bb.http.route("POST", "/test", () => {
    broadcast({
      type: "notify",
      threadId: "test",
      kind: "idle",
      title: "Проверка уведомлений",
      text: "Так выглядит плашка, когда агент закончил работу.",
      at: Date.now(),
    });
    return Response.json({ ok: true, clients: clients.size });
  });

  // ── Источники событий ────────────────────────────────────────────────────
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    if (thread.visibility !== "visible") return;
    notify("idle", thread, lastAssistantText);
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    if (thread.visibility !== "visible") return;
    notify("failed", thread, error);
  });

  // Тред снова побежал — значит внимание он уже получил.
  bb.events.on("thread.active", ({ thread }) => clearAttention(thread.id));
  bb.events.on("thread.archived", ({ thread }) => clearAttention(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => clearAttention(thread.id));

  // «Агент задал вопрос» отдельным событием не приходит: это pending
  // interaction на треде. Ловим появление опросом — дешёвый локальный вызов.
  const pending = new Set<string>();
  let primed = false;

  bb.background.service("pending-interaction-watch", {
    async start(signal) {
      let ticks = 0;
      while (!signal.aborted) {
        try {
          const threads = await bb.sdk.threads.list({ signal });
          const current = new Set<string>();
          for (const thread of threads) {
            // Метку снимает сам факт прочтения треда — открыл мышкой, из
            // плашки, откуда угодно.
            const entry = attention.get(thread.id);
            if (entry !== undefined) {
              const read =
                thread.lastReadAt !== null && thread.lastReadAt >= entry.at;
              const answered =
                entry.kind === "question" && !thread.hasPendingInteraction;
              if (read || answered) clearAttention(thread.id);
            }
            if (!thread.hasPendingInteraction) continue;
            current.add(thread.id);
            if (primed && !pending.has(thread.id)) {
              notify("question", thread, "Агент ждёт твоего ответа.");
            }
          }
          pending.clear();
          for (const id of current) pending.add(id);
          primed = true;
        } catch (error) {
          bb.log.warn(`не смог опросить треды: ${String(error)}`);
        }
        // Пинг раз в ~24 секунды: держит SSE живым через прокси.
        if (++ticks % 12 === 0) broadcast({ type: "ping" });
        await sleep(2000, signal);
      }
    },
  });

  // `bb notify status` — состояние без догадок: что висит и сколько окон на связи.
  bb.cli.register({
    name: "notify",
    summary: "Уведомления о работе агентов: состояние и снятие меток",
    commands: [
      {
        name: "status",
        summary: "Что сейчас ждёт внимания и сколько окон BB на связи",
        usage: "bb notify status [--json]",
      },
      {
        name: "clear",
        summary: "Снять все метки",
        usage: "bb notify clear",
      },
    ],
    run(argv) {
      const json = argv.includes("--json");
      const [command] = argv.filter((arg) => arg !== "--json");
      if (command === "clear") {
        attention.clear();
        publishAttention();
        return { exitCode: 0, stdout: "Метки сняты." };
      }
      if (command === undefined || command === "status") {
        const entries = attentionList();
        if (json) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ windows: clients.size, entries }),
          };
        }
        const lines = [
          `Окон BB на связи: ${clients.size}`,
          `Ждут внимания: ${entries.length}`,
          ...entries.map(
            (entry) => `  ${entry.kind}  ${entry.threadId}  ${entry.title}`,
          ),
        ];
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      return {
        exitCode: 1,
        stderr: "Usage:\n  bb notify status [--json]\n  bb notify clear",
      };
    },
  });

  bb.onDispose(() => {
    for (const controller of [...clients]) {
      try {
        controller.close();
      } catch {
        // соединение уже закрыто клиентом
      }
    }
    clients.clear();
  });

  bb.log.info("плагин уведомлений загружен");
}
