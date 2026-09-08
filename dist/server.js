import { createRequire as __createRequire } from "node:module";
import { dirname as __pathDirname } from "node:path";
import { fileURLToPath as __fileURLToPath } from "node:url";
const require = __createRequire(import.meta.url);
var __filename = __fileURLToPath(import.meta.url);
var __dirname = __pathDirname(__filename);

// server.ts
function threadTitle(thread) {
  const name = thread.title ?? thread.titleFallback ?? "";
  const trimmed = name.trim();
  return trimmed === "" ? "\u0422\u0440\u0435\u0434 \u0431\u0435\u0437 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u044F" : clamp(trimmed, 70);
}
function clamp(value, limit) {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}\u2026`;
}
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
async function plugin(bb) {
  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "\u0423\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F \u0432\u043A\u043B\u044E\u0447\u0435\u043D\u044B",
      default: true
    },
    sound: { type: "boolean", label: "\u0417\u0432\u0443\u043A", default: true },
    onIdle: {
      type: "boolean",
      label: "\u041A\u043E\u0433\u0434\u0430 \u0430\u0433\u0435\u043D\u0442 \u0437\u0430\u043A\u043E\u043D\u0447\u0438\u043B \u0440\u0430\u0431\u043E\u0442\u0443",
      default: true
    },
    onQuestion: {
      type: "boolean",
      label: "\u041A\u043E\u0433\u0434\u0430 \u0430\u0433\u0435\u043D\u0442 \u0436\u0434\u0451\u0442 \u0442\u0432\u043E\u0435\u0433\u043E \u043E\u0442\u0432\u0435\u0442\u0430",
      default: true
    },
    onFailed: {
      type: "boolean",
      label: "\u041A\u043E\u0433\u0434\u0430 \u0442\u0440\u0435\u0434 \u0443\u043F\u0430\u043B \u0441 \u043E\u0448\u0438\u0431\u043A\u043E\u0439",
      default: true
    },
    silentWhenVisible: {
      type: "boolean",
      label: "\u041C\u043E\u043B\u0447\u0430\u0442\u044C, \u0435\u0441\u043B\u0438 \u044D\u0442\u043E\u0442 \u0442\u0440\u0435\u0434 \u043E\u0442\u043A\u0440\u044B\u0442 \u0438 \u043E\u043A\u043D\u043E \u0432 \u0444\u043E\u043A\u0443\u0441\u0435",
      default: true
    },
    voiceHotkey: {
      type: "string",
      label: "\u041A\u043B\u0430\u0432\u0438\u0448\u0430 \u043C\u0438\u043A\u0440\u043E\u0444\u043E\u043D\u0430 (\u0442\u0443\u043C\u0431\u043B\u0435\u0440): \u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440 mod+shift+d, alt+v, f5. \u041F\u0443\u0441\u0442\u043E \u2014 \u0432\u044B\u043A\u043B\u044E\u0447\u0438\u0442\u044C",
      default: "mod+shift+d"
    }
  });
  let config = await settings.get();
  settings.onChange((next) => {
    config = next;
    broadcast({ type: "config", config });
  });
  const encoder = new TextEncoder();
  const clients = /* @__PURE__ */ new Set();
  function push(controller, signal) {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(signal)}

`));
  }
  function broadcast(signal) {
    for (const controller of [...clients]) {
      try {
        push(controller, signal);
      } catch {
        clients.delete(controller);
      }
    }
  }
  const attention = /* @__PURE__ */ new Map();
  function attentionList() {
    return [...attention.values()].sort((left, right) => right.at - left.at);
  }
  function publishAttention() {
    broadcast({ type: "attention", entries: attentionList() });
  }
  function clearAttention(threadId) {
    if (!attention.delete(threadId)) return;
    publishAttention();
  }
  function notify(kind, thread, text) {
    if (!config.enabled) return;
    if (kind === "idle" && !config.onIdle) return;
    if (kind === "question" && !config.onQuestion) return;
    if (kind === "failed" && !config.onFailed) return;
    const entry = {
      threadId: thread.id,
      kind,
      title: threadTitle(thread),
      text: text === null ? null : clamp(text, 160),
      at: Date.now()
    };
    if (kind !== "idle") attention.set(entry.threadId, entry);
    bb.log.info(
      `\u0441\u0438\u0433\u043D\u0430\u043B \xAB${kind}\xBB \u043F\u043E \u0442\u0440\u0435\u0434\u0443 ${thread.id} \u2192 \u043E\u043A\u043E\u043D BB \u043D\u0430 \u0441\u0432\u044F\u0437\u0438: ${clients.size}`
    );
    broadcast({ type: "notify", ...entry });
    publishAttention();
  }
  bb.http.route("GET", "/events", () => {
    let own = null;
    const stream = new ReadableStream({
      start(controller) {
        own = controller;
        clients.add(controller);
        push(controller, { type: "config", config });
        push(controller, { type: "attention", entries: attentionList() });
      },
      cancel() {
        if (own !== null) clients.delete(own);
      }
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      }
    });
  });
  bb.http.route("POST", "/open", async (context) => {
    let threadId;
    try {
      ({ threadId } = await context.req.json());
    } catch {
      return Response.json(
        { ok: false, error: "invalid_json" },
        { status: 400 }
      );
    }
    if (typeof threadId !== "string" || threadId === "") {
      return Response.json({ ok: false, error: "no_thread" }, { status: 400 });
    }
    clearAttention(threadId);
    try {
      await bb.sdk.threads.open({ threadId, file: null });
    } catch (error) {
      bb.log.warn(`\u043D\u0435 \u0441\u043C\u043E\u0433 \u043E\u0442\u043A\u0440\u044B\u0442\u044C \u0442\u0440\u0435\u0434 ${threadId}: ${String(error)}`);
      return Response.json({ ok: false, error: String(error) }, { status: 500 });
    }
    return Response.json({ ok: true });
  });
  bb.http.route("POST", "/dismiss", async (context) => {
    let threadId;
    try {
      ({ threadId } = await context.req.json());
    } catch {
      return Response.json(
        { ok: false, error: "invalid_json" },
        { status: 400 }
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
  bb.http.route(
    "GET",
    "/attention",
    () => Response.json({ entries: attentionList() })
  );
  bb.http.route("POST", "/test", () => {
    broadcast({
      type: "notify",
      threadId: "test",
      kind: "idle",
      title: "\u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0439",
      text: "\u0422\u0430\u043A \u0432\u044B\u0433\u043B\u044F\u0434\u0438\u0442 \u043F\u043B\u0430\u0448\u043A\u0430, \u043A\u043E\u0433\u0434\u0430 \u0430\u0433\u0435\u043D\u0442 \u0437\u0430\u043A\u043E\u043D\u0447\u0438\u043B \u0440\u0430\u0431\u043E\u0442\u0443.",
      at: Date.now()
    });
    return Response.json({ ok: true, clients: clients.size });
  });
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    if (thread.visibility !== "visible") return;
    notify("idle", thread, lastAssistantText);
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    if (thread.visibility !== "visible") return;
    notify("failed", thread, error);
  });
  bb.events.on("thread.active", ({ thread }) => clearAttention(thread.id));
  bb.events.on("thread.archived", ({ thread }) => clearAttention(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => clearAttention(thread.id));
  const pending = /* @__PURE__ */ new Set();
  let primed = false;
  bb.background.service("pending-interaction-watch", {
    async start(signal) {
      let ticks = 0;
      while (!signal.aborted) {
        try {
          const threads = await bb.sdk.threads.list({ signal });
          const current = /* @__PURE__ */ new Set();
          for (const thread of threads) {
            const entry = attention.get(thread.id);
            if (entry !== void 0) {
              const read = thread.lastReadAt !== null && thread.lastReadAt >= entry.at;
              const answered = entry.kind === "question" && !thread.hasPendingInteraction;
              if (read || answered) clearAttention(thread.id);
            }
            if (!thread.hasPendingInteraction) continue;
            current.add(thread.id);
            if (primed && !pending.has(thread.id)) {
              notify("question", thread, "\u0410\u0433\u0435\u043D\u0442 \u0436\u0434\u0451\u0442 \u0442\u0432\u043E\u0435\u0433\u043E \u043E\u0442\u0432\u0435\u0442\u0430.");
            }
          }
          pending.clear();
          for (const id of current) pending.add(id);
          primed = true;
        } catch (error) {
          bb.log.warn(`\u043D\u0435 \u0441\u043C\u043E\u0433 \u043E\u043F\u0440\u043E\u0441\u0438\u0442\u044C \u0442\u0440\u0435\u0434\u044B: ${String(error)}`);
        }
        if (++ticks % 12 === 0) broadcast({ type: "ping" });
        await sleep(2e3, signal);
      }
    }
  });
  bb.cli.register({
    name: "notify",
    summary: "\u0423\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F \u043E \u0440\u0430\u0431\u043E\u0442\u0435 \u0430\u0433\u0435\u043D\u0442\u043E\u0432: \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u0438 \u0441\u043D\u044F\u0442\u0438\u0435 \u043C\u0435\u0442\u043E\u043A",
    commands: [
      {
        name: "status",
        summary: "\u0427\u0442\u043E \u0441\u0435\u0439\u0447\u0430\u0441 \u0436\u0434\u0451\u0442 \u0432\u043D\u0438\u043C\u0430\u043D\u0438\u044F \u0438 \u0441\u043A\u043E\u043B\u044C\u043A\u043E \u043E\u043A\u043E\u043D BB \u043D\u0430 \u0441\u0432\u044F\u0437\u0438",
        usage: "bb notify status [--json]"
      },
      {
        name: "clear",
        summary: "\u0421\u043D\u044F\u0442\u044C \u0432\u0441\u0435 \u043C\u0435\u0442\u043A\u0438",
        usage: "bb notify clear"
      }
    ],
    run(argv) {
      const json = argv.includes("--json");
      const [command] = argv.filter((arg) => arg !== "--json");
      if (command === "clear") {
        attention.clear();
        publishAttention();
        return { exitCode: 0, stdout: "\u041C\u0435\u0442\u043A\u0438 \u0441\u043D\u044F\u0442\u044B." };
      }
      if (command === void 0 || command === "status") {
        const entries = attentionList();
        if (json) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ windows: clients.size, entries })
          };
        }
        const lines = [
          `\u041E\u043A\u043E\u043D BB \u043D\u0430 \u0441\u0432\u044F\u0437\u0438: ${clients.size}`,
          `\u0416\u0434\u0443\u0442 \u0432\u043D\u0438\u043C\u0430\u043D\u0438\u044F: ${entries.length}`,
          ...entries.map(
            (entry) => `  ${entry.kind}  ${entry.threadId}  ${entry.title}`
          )
        ];
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      return {
        exitCode: 1,
        stderr: "Usage:\n  bb notify status [--json]\n  bb notify clear"
      };
    }
  });
  bb.onDispose(() => {
    for (const controller of [...clients]) {
      try {
        controller.close();
      } catch {
      }
    }
    clients.clear();
  });
  bb.log.info("\u043F\u043B\u0430\u0433\u0438\u043D \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0439 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043D");
}
export {
  plugin as default
};
//# sourceMappingURL=server.js.map
