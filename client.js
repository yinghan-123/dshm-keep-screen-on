/**
 * dshm-keep-screen-on —— 浏览器半部（跑在 ArkWeb 里）。
 *
 * ── 职责 ──────────────────────────────────────────────────────────────────
 * 1. 真正让屏幕不灭的只有页面能调的 W3C Screen Wake Lock：
 *        navigator.wakeLock.request("screen")
 *    本文件轮询 Host 的 GET /dshm-keep-screen-on 拿「现在该不该常亮」，
 *    该常亮就申请、不该就释放，并把结果上报回 Host。
 * 2. 在输入框下方的用量栏（`conversation.composer.dock` 槽）渲染一个「屏幕常亮」胶囊，
 *    与回合/速度、Token 用量这些原生胶囊并排：
 *    点一下 = 强制常亮（mode: always），再点 = 任务时自动（mode: auto）。
 *
 * ── v0.2.0 修复（2026-10-25）──────────────────────────────────────────────
 * 真机症状：点胶囊「没反应 / 刚变过去又跳回来」。
 * · 整页只保留**一个**状态轮询循环（原来 start() 的 4s 轮询与胶囊自己的 5s 轮询
 *   各自打一份 GET，宿主同时被两条链轮询，且 GET 每次都触发全量活动扫描）。
 *   现在 sync() 拿到的快照进模块级缓存，胶囊订阅这份缓存，不再自己打接口。
 * · 点击不再依赖宿主 Tooltip 的事件转发：胶囊直接绑 onClick + onPointerUp
 *   （pointerup 兜底 ArkWeb 上 click 合成异常；两者 400ms 去重、位移 >12px 不算点击）。
 * · 点击后进入 `PENDING_MS`（8s）保护窗：轮询拿回的旧 mode 不会覆盖用户刚点的选择，
 *   等 Host 明确确认（返回 mode === 目标）或超时才回滚 —— 这是「状态又跳回去」的正解。
 * · 设置请求带 AbortController 与 6s 超时，busy 不再可能永久卡住把后续点击全吞掉。
 * · 每次点击 / 成功 / 失败都通过 report 上报到 Host 日志（support=… state=… detail=tap:always
 *   这类），以后「到底点没点到」不用再猜。
 *
 * ── 关键行为 ──────────────────────────────────────────────────────────────
 * · 页面隐藏（切后台）时浏览器本来就会释放 Wake Lock，这里显式释放并记住；
 *   页面重新可见立即重新申请（靠 visibilitychange 这个即时事件，而不是等
 *   可能被节流的定时器）。
 * · 申请失败（例如 NotAllowedError）不疯狂重试：记下 error 名称与消息，
 *   30s 之后再试；期间每次回到可见也会重试。
 * · 一切异常静默：桥坏了最多是「没常亮／开关显示未就绪」，绝不能让 GUI 报错。
 *
 * ── 加载模型 ──────────────────────────────────────────────────────────────
 * 与 dshm-keepalive 相同：DSH 客户端模块是惰性 CJS，工厂体可能先于挂载执行，
 * 所以启动逻辑放在 apply(ctx) 里。
 *
 * @module dshm-keep-screen-on/client
 */

window.__ModuleLoader__.load({
  id: "dshm-keep-screen-on",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    // portal 用（宿主 ui-chat 的统计弹层也是这么拿的）；拿不到就原地渲染，不影响功能。
    var ReactDOM = null;
    try {
      ReactDOM = require("react-dom");
    } catch (error) {
      ReactDOM = null;
    }
    // 原生组件库由页面模块表提供（package.json 的 dsh.client.inject 已声明）。
    // 万一带不进来也不影响屏幕常亮本身：开关会退化成原生风格的文字按钮。
    var primitives = null;
    try {
      primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch (error) {
      primitives = null;
    }

    /** Host 侧路由。 */
    var ROUTE = "/dshm-keep-screen-on";
    /** 状态轮询周期（整页唯一一条循环）。 */
    var POLL_MS = 8000;
    /** 心跳上报周期（状态没变也报一次，让 Host 知道页面还活着）。 */
    var REPORT_MS = 30000;
    /** 申请失败后的重试间隔。 */
    var RETRY_MS = 30000;
    /** 一次「点胶囊 → Host 确认」的最长等待：超过就解除 busy，不让后续点击被吞。 */
    var BUSY_MS = 6000;
    /** 点击后的乐观值保护窗：窗内轮询拿到的旧 mode 不覆盖用户的选择。 */
    var PENDING_MS = 8000;
    /** 快照过期判定：超过这个时长没拿到新状态，胶囊才主动补拉一次。 */
    var STALE_MS = 14000;
    /** 点击去重（pointerup 与 click 会先后各来一次；窗口取宽一点，防 ArkWeb 延迟合成 click）。 */
    var TAP_DEDUPE_MS = 1000;
    /** 两次 GET 之间的最小间隔（定时器与「补拉」可能同时醒）。 */
    var SYNC_MIN_GAP_MS = 1500;

    var started = false;
    var timer = null;
    var heartbeat = null;
    var sentinel = null;
    var asking = false;
    var retryAt = 0;
    /** 本次持锁开始时刻（用于识别「页面可见却被系统立刻释放」）。 */
    var heldAt = 0;
    /** 页面可见时持锁却在 5s 内被浏览器释放 ⇒ 常亮很可能没落到系统层。 */
    var flaky = false;
    /** 是否跑在 DSHM 客户端里（ArkTS 桥存在）——用于适配提示的措辞。 */
    var inDshmClient = (typeof globalThis !== "undefined" && globalThis !== null
      && globalThis.__DSHM_BRIDGES__ !== undefined && globalThis.__DSHM_BRIDGES__ !== null);

    /** ArkWeb 是否暴露了 Wake Lock API。 */
    var support = (typeof navigator !== "undefined" && navigator.wakeLock !== undefined && navigator.wakeLock !== null)
      ? "ok"
      : "unsupported";

    /** 当前本地状态：idle / held / released / denied:* / unsupported。 */
    var state = support === "ok" ? "idle" : "unsupported";
    var detail = "";
    var lastReportAt = 0;
    var lastReportKey = "";

    var stats = {
      requests: 0,
      grants: 0,
      denials: 0,
      releases: 0,
      polls: 0,
      pollErrors: 0,
      lastPollAt: 0,
      wanted: false
    };

    // ---------------------------------------------------------------- 共享快照
    //
    // 整页只有一个轮询循环（start() 里的 sync），胶囊订阅这份快照。
    // 之前的版本里 start() 每 4s、胶囊每 5s 各打一次 GET，宿主侧每次 GET 都
    // 触发全量活动扫描；两条链叠加既浪费又让「点一下」的响应被拖慢。
    var snapshot = null;
    var snapshotAt = 0;
    var listeners = [];
    var syncing = false;
    var lastSyncAt = 0;
    /** 任何一次 GET 响应到达的时刻（保护窗拒收也算），用于判断快照是否过期。 */
    var lastResponseAt = 0;
    /**
     * 请求世代：点击（POST）会 +1。点击前已经发出去、点击后才回来的旧 GET
     * 属于上一世代，必须丢弃 —— 否则它带着旧 mode 把刚切过去的状态又推回去。
     */
    var syncEpoch = 0;
    /** 本轮 GET 的发起时刻（配合看门狗解 syncing，防止连接冻结后轮询永久停摆）。 */
    var syncStartedAt = 0;
    /** 用户刚点的目标模式；保护窗内不接受与它冲突的 Host 快照。 */
    var pendingMode = "";
    var pendingUntil = 0;

    function post(body) {
      try {
        fetch(ROUTE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          keepalive: true,
          cache: "no-store",
          credentials: "same-origin"
        }).catch(function () {
          /* 桥不在（插件未装/宿主重启）：静默 */
        });
      } catch (error) {
        /* ignore */
      }
    }

    /**
     * 上报本地状态；只在变化或超过心跳周期时真正发一次。
     * @param force - 强制发一次
     * @param extraDetail - 覆盖 detail（用于把点击/失败写进 Host 日志）
     */
    function report(force, extraDetail) {
      var extra = extraDetail === undefined || extraDetail === null ? "" : String(extraDetail);
      var body = extra === "" ? detail : extra;
      var key = support + "|" + state + "|" + body;
      var now = Date.now();
      if (!force && key === lastReportKey && now - lastReportAt < REPORT_MS) return;
      lastReportKey = key;
      lastReportAt = now;
      post({ action: "report", support: support, state: state, detail: body });
    }

    function setState(next, nextDetail) {
      state = next;
      detail = nextDetail === undefined ? "" : String(nextDetail).slice(0, 160);
    }

    /** 申请 Wake Lock（幂等；失败退避 30s）。 */
    function acquire() {
      if (support !== "ok" || sentinel !== null || asking) return;
      if (Date.now() < retryAt) return;
      asking = true;
      var askedAt = Date.now();
      // 兜底：wakeLock.request() 在页面被节流时可能长期不 settle。
      // asking 若永久为真就再也不会申请常亮了（state 还停在 idle），所以 10s 强解。
      setTimeout(function () {
        if (asking && Date.now() - askedAt >= 10000) asking = false;
      }, 10500);
      stats.requests += 1;
      var pending;
      try {
        pending = navigator.wakeLock.request("screen");
      } catch (error) {
        asking = false;
        stats.denials += 1;
        setState("denied:throw", error && error.message ? error.message : String(error));
        retryAt = Date.now() + RETRY_MS;
        report(true);
        return;
      }
      pending.then(function (lock) {
        asking = false;
        sentinel = lock;
        stats.grants += 1;
        heldAt = Date.now();
        flaky = false;
        setState("held");
        try {
          lock.addEventListener("release", function () {
            sentinel = null;
            stats.releases += 1;
            // 页面可见、锁却几乎立刻被浏览器释放 ⇒ ArkWeb 拿到了锁但没落到系统层，
            // 屏幕大概率仍会熄灭。标记出来，胶囊会给「未生效」的适配提示。
            var visible = typeof document === "undefined" || document.visibilityState === "visible";
            if (visible && heldAt > 0 && Date.now() - heldAt < 5000) {
              flaky = true;
              try {
                console.warn("[dshm-keep-screen-on] 页面可见但 Wake Lock 被立即释放：屏幕常亮可能未生效");
              } catch (ignored) {
                /* ignore */
              }
            }
            if (state === "held") setState("released", "browser");
            report(true);
          });
        } catch (error) {
          /* 老实现没有 addEventListener：忽略 */
        }
        report(true);
      }, function (error) {
        asking = false;
        stats.denials += 1;
        setState("denied:" + (error && error.name ? error.name : "error"),
          error && error.message ? error.message : String(error));
        retryAt = Date.now() + RETRY_MS;
        report(true);
      });
    }

    /** 释放 Wake Lock（幂等）。 */
    function release(reason) {
      if (sentinel === null) {
        if (state === "held") {
          setState("released", reason === undefined ? "" : reason);
          report(true);
        }
        return;
      }
      var lock = sentinel;
      sentinel = null;
      setState("released", reason === undefined ? "" : reason);
      try {
        var result = lock.release();
        if (result !== undefined && typeof result.catch === "function") {
          result.catch(function () {
            /* 已释放 */
          });
        }
      } catch (error) {
        /* 已释放 */
      }
      report(true);
    }

    function emit() {
      var value = snapshot;
      for (var i = 0; i < listeners.length; i += 1) {
        try {
          listeners[i](value);
        } catch (error) {
          /* 单个订阅者坏了不影响其它订阅者 */
        }
      }
    }

    function subscribe(listener) {
      listeners.push(listener);
      return function () {
        var index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    }

    /**
     * 收下一份 Host 快照。
     * 保护窗内（用户刚点完，Host 还没确认）不接受与点击目标冲突的 mode，
     * 否则轮询会把「强制」一闪又推回「常亮」——真机症状就是这一条。
     * @returns 是否采信
     */
    function acceptSnapshot(payload) {
      if (payload === null || payload === undefined) return false;
      var now = Date.now();
      if (pendingMode !== "" && now < pendingUntil) {
        if (payload.mode !== pendingMode) return false;
        pendingMode = "";
        pendingUntil = 0;
      } else if (pendingMode !== "" && now >= pendingUntil) {
        pendingMode = "";
        pendingUntil = 0;
      }
      snapshot = payload;
      snapshotAt = now;
      emit();
      return true;
    }

    /** 拉一次 Host 判定，并据此增/减常亮。 */
    function sync() {
      if (!started) return;
      if (typeof document === "undefined" || document.visibilityState !== "visible") {
        // 页面不可见：浏览器会自行释放，这里同步本地状态即可。
        if (sentinel !== null) release("hidden");
        return;
      }
      var now = Date.now();
      // 看门狗：连接冻结时 fetch 可能既不 resolve 也不 reject，
      // 不能让 syncing 永久为真把整页轮询锁死。
      if (syncing && now - syncStartedAt > 15000) syncing = false;
      if (syncing || now - lastSyncAt < SYNC_MIN_GAP_MS) return;
      syncing = true;
      lastSyncAt = now;
      syncStartedAt = now;
      var epoch = syncEpoch;
      var controller = null;
      var options = { cache: "no-store", credentials: "same-origin" };
      try {
        if (typeof AbortController === "function") {
          controller = new AbortController();
          options.signal = controller.signal;
        }
      } catch (ignored) {
        controller = null;
      }
      var watchdog = null;
      if (controller !== null) {
        watchdog = setTimeout(function () {
          try {
            controller.abort();
          } catch (ignored) {
            /* ignore */
          }
        }, 8000);
      }
      fetch(ROUTE, options)
        .then(function (response) {
          if (!response.ok) throw new Error("status " + response.status);
          return response.json();
        })
        .then(function (payload) {
          if (watchdog !== null) {
            clearTimeout(watchdog);
            watchdog = null;
          }
          syncing = false;
          lastResponseAt = Date.now();
          stats.polls += 1;
          stats.lastPollAt = Date.now();
          if (epoch !== syncEpoch) return; // 点击后的新世代：丢弃在途旧快照
          stats.wanted = payload !== null && payload !== undefined && payload.active === true;
          acceptSnapshot(payload);
          if (stats.wanted) acquire();
          else release("idle");
        })
        .catch(function (error) {
          if (watchdog !== null) {
            clearTimeout(watchdog);
            watchdog = null;
          }
          syncing = false;
          stats.pollErrors += 1;
          if (stats.pollErrors === 1) {
            try {
              console.info("[dshm-keep-screen-on] 拉取状态失败（下一次轮询重试）：", error && error.message ? error.message : error);
            } catch (ignored) {
              /* ignore */
            }
          }
        });
    }

    /** 让下一次 sync() 不受最小间隔限制（用户点击后补拉、胶囊挂载时补拉）。 */
    function requestSync() {
      lastSyncAt = 0;
      sync();
    }

    /** 启动：只在 apply 里调一次。 */
    function start() {
      if (started) return;
      started = true;

      // 首拍：页面一加载就向 Host 要结论，别等第一轮计时。
      sync();
      timer = setInterval(sync, POLL_MS);
      // 心跳：状态没变也每 30s 报一次，让 Host 知道页面还活着（client.ageMs 不会无限涨）。
      heartbeat = setInterval(report, REPORT_MS);

      // 前后台切换：隐藏立即释放，可见立即补一次申请（不依赖被节流的定时器）。
      try {
        document.addEventListener("visibilitychange", function () {
          try {
            // 回到可见时清掉「申请失败」退避：否则最多要等 30s 才恢复常亮。
            if (typeof document !== "undefined" && document.visibilityState === "visible" && sentinel === null) {
              retryAt = 0;
            }
            requestSync();
            report();
          } catch (error) {
            /* ignore */
          }
        });
      } catch (error) {
        /* ignore */
      }

      // 页面卸载：尽力释放（浏览器也会自动释放，这里是礼貌动作）。
      try {
        window.addEventListener("pagehide", function () {
          try {
            if (sentinel !== null) {
              var lock = sentinel;
              sentinel = null;
              var result = lock.release();
              if (result !== undefined && typeof result.catch === "function") result.catch(function () {});
            }
          } catch (error) {
            /* ignore */
          }
        });
      } catch (error) {
        /* ignore */
      }

      report(true, "mount");

      /** 诊断入口：页面控制台 `__dshmKeepScreenOn()`。 */
      try {
        window.__dshmKeepScreenOn = function () {
          return {
            support: support,
            state: state,
            detail: detail,
            held: sentinel !== null,
            wanted: stats.wanted,
            visible: typeof document !== "undefined" ? document.visibilityState : "unknown",
            mode: snapshot === null ? null : snapshot.mode,
            active: snapshot === null ? null : snapshot.active,
            snapshotAgeMs: snapshotAt === 0 ? null : Date.now() - snapshotAt,
            pendingMode: pendingMode,
            pendingUntil: pendingUntil,
            pollErrors: stats.pollErrors,
            stats: stats,
            pollMs: POLL_MS,
            retryAt: retryAt
          };
        };
        /** 手动切模式：`__dshmKeepScreenOn.mode('always'|'auto'|'off')`。 */
        window.__dshmKeepScreenOn.mode = function (mode) {
          // 与控制台以外的点击走同一套保护：先占住世代与保护窗，
          // 否则手动切换会被下一轮轮询的旧快照立刻回跳。
          if (mode === "always" || mode === "auto") {
            syncEpoch += 1;
            pendingMode = mode;
            pendingUntil = Date.now() + PENDING_MS;
          }
          return fetch(ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "set", mode: mode }),
            cache: "no-store",
            credentials: "same-origin"
          }).then(function (response) {
            return response.json();
          });
        };
      } catch (error) {
        /* ignore */
      }

      try {
        console.info("[dshm-keep-screen-on] 已启动：support=" + support + "，轮询 " + ROUTE);
      } catch (error) {
        /* ignore */
      }
    }

    // ---------------------------------------------------------------- 界面
    //
    // 注册到 conversation.composer.dock（输入框下方那排用量胶囊：回合/速度、Token 用量、上下文占用）。
    //
    // v0.2.1：手机窄屏下 dock 空间紧张，胶囊里的文字会被 flex 压掉、只剩图标，
    // 用户看不出当前是哪种模式。所以改成「图标按钮 + 点击弹出菜单」：
    //   点图标 → 弹出菜单，明确列出 强制常亮 / 任务时自动 / 关闭 三个选项，
    //   当前项打勾、顶部显示实时状态（支持 / 持锁中 / 未生效），底部一句适配说明。
    // 状态仍以 Host 为准，选择走乐观更新 + 保护窗，不会被轮询回跳。

    const NS = "dshmKeepScreenOn";

    const zh = {
      "bar.label": "屏幕常亮",
      "bar.on": "强制常亮",
      "bar.auto": "任务时自动",
      "bar.off": "已关闭",
      "bar.connecting": "连接中…",
      "bar.bridgeDown": "桥未就绪",
      "bar.failed": "设置失败"
    };

    const en = {
      "bar.label": "Keep screen on",
      "bar.on": "Always on",
      "bar.auto": "While running",
      "bar.off": "Off",
      "bar.connecting": "Connecting…",
      "bar.bridgeDown": "Bridge unavailable",
      "bar.failed": "Update failed"
    };

    // 触发按钮照抄宿主用量胶囊的尺寸（28px 见方、14/15px 图标、同款 hover 底），
    // 菜单面板照抄宿主 stat dialog 的视觉（--dsw-specific-menu / radius-lg / prominent 阴影）。
    const css = [
      ".dshmKsoAnchor{min-width:0;display:inline-flex;position:relative}",
      ".dshmKsoPill{box-sizing:border-box;width:28px;height:28px;border-radius:var(--dsw-radius-sm);",
      "color:var(--dsw-alias-label-tertiary);font:inherit;line-height:inherit;background:0 0;border:none;",
      "align-items:center;justify-content:center;padding:0;display:inline-flex;cursor:pointer;position:relative;",
      "transition:background .12s ease,color .12s ease;-webkit-tap-highlight-color:transparent}",
      ".dshmKsoPill svg{flex:none;width:15px;height:15px}",
      ".dshmKsoPill:hover,.dshmKsoPill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);",
      "color:var(--dsw-alias-label-secondary)}",
      ".dshmKsoPill:active{transform:translateY(.5px)}",
      ".dshmKsoPill.on{color:var(--dsw-alias-brand-primary);",
      "background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}",
      ".dshmKsoPill.active{color:var(--dsw-alias-brand-primary)}",
      ".dshmKsoPill.warn{color:var(--dsw-alias-state-warn-primary)}",
      ".dshmKsoPill.err{color:var(--dsw-alias-state-error-primary)}",
      ".dshmKsoDot{position:absolute;right:4px;top:4px;width:5px;height:5px;border-radius:50%;",
      "background:var(--dsw-alias-brand-primary);opacity:0;box-sizing:border-box}",
      ".dshmKsoPill.active .dshmKsoDot{opacity:1}",
      ".dshmKsoPill.warn .dshmKsoDot{opacity:1;background:var(--dsw-alias-state-warn-primary)}",
      ".dshmKsoPill.err .dshmKsoDot{opacity:1;background:var(--dsw-alias-state-error-primary)}",
      ".dshmKsoMenu{position:fixed;z-index:1100;box-sizing:border-box;width:272px;",
      "max-width:calc(100vw - 24px);padding:8px 8px 6px;border-radius:var(--dsw-radius-lg);",
      "background:var(--dsw-specific-menu,var(--dsw-alias-bg-l1,#fff));color:var(--dsw-alias-label-secondary);",
      "backdrop-filter:var(--dsw-menu-backdrop-filter);border:.5px solid var(--dsw-alias-border-l1);",
      "box-shadow:var(--dsw-elevation-prominent,var(--dsw-elevation-panel));font-size:12px;line-height:18px;",
      "cursor:default;text-align:left}",
      ".dshmKsoMenuHead{display:flex;justify-content:space-between;align-items:baseline;gap:12px;",
      "padding:4px 8px 8px}",
      ".dshmKsoMenuTitle{color:var(--dsw-alias-label-primary);font-weight:500;font-size:13px}",
      ".dshmKsoMenuState{color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-size:11px}",
      ".dshmKsoMenuState.warn{color:var(--dsw-alias-state-warn-primary)}",
      ".dshmKsoMenuState.err{color:var(--dsw-alias-state-error-primary)}",
      ".dshmKsoMenuRule{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 6px 6px}",
      ".dshmKsoMenuItem{width:100%;box-sizing:border-box;display:block;text-align:left;padding:7px 10px;",
      "border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-primary);",
      "font:inherit;cursor:pointer;position:relative;-webkit-tap-highlight-color:transparent}",
      ".dshmKsoMenuItem:hover,.dshmKsoMenuItem:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dshmKsoMenuItem.checked{color:var(--dsw-alias-brand-primary)}",
      ".dshmKsoMenuItemLabel{display:block;font-size:13px;line-height:18px;font-weight:500;padding-right:18px}",
      ".dshmKsoMenuItemHint{display:block;color:var(--dsw-alias-label-tertiary);font-size:11px;",
      "line-height:15px;padding-right:18px}",
      ".dshmKsoCheck{position:absolute;right:10px;top:50%;transform:translateY(-50%);",
      "color:var(--dsw-alias-brand-primary);font-size:13px;font-weight:600;line-height:1}",
      ".dshmKsoMenuNote{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;",
      "border-top:.5px solid var(--dsw-alias-border-l2);margin:6px 6px 0;padding:6px 2px 2px}"
    ].join("");

    const cssTagId = "dshm-keep-screen-on/bar.css";
    try {
      if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(cssTagId) + "]") === null) {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dshm-keep-screen-on";
        tag.dataset.pluginCss = cssTagId;
        tag.textContent = css;
        document.head.appendChild(tag);
      }
    } catch (error) {
      /* 样式失败不影响功能 */
    }

    /** Host 快照里的 mode；缺省按 auto。 */
    function modeOf(data) {
      return data !== null && data !== undefined && typeof data.mode === "string" ? data.mode : "auto";
    }

    /** 菜单里的三个模式项（顺序稳定，状态文案与菜单共用）。 */
    const MODE_ITEMS = [
      { mode: "always", label: "强制常亮", hint: "不管有没有任务，一直常亮" },
      { mode: "auto", label: "任务时自动", hint: "有任务在跑才常亮，结束后宽限 60s" },
      { mode: "off", label: "关闭", hint: "本插件不申请常亮" }
    ];

    /** 弹层定位：锚在按钮正上方，放不下就翻到下方，并夹在视口内。 */
    function computeMenuPos(rootRef, panelRef) {
      try {
        const root = rootRef.current;
        const panel = panelRef.current;
        if (root === null || panel === null) return null;
        const anchor = root.getBoundingClientRect();
        const box = panel.getBoundingClientRect();
        const margin = 12;
        const gap = 8;
        let left = anchor.left + anchor.width / 2 - box.width / 2;
        left = Math.max(margin, Math.min(left, window.innerWidth - margin - box.width));
        let top = anchor.top - gap - box.height;
        if (top < margin) top = anchor.bottom + gap;
        if (top + box.height > window.innerHeight - margin) {
          top = Math.max(margin, window.innerHeight - margin - box.height);
        }
        return { left: Math.round(left), top: Math.round(top) };
      } catch (error) {
        return null;
      }
    }

    /** 底部开关组件：图标按钮 + 弹出菜单。 */
    function ScreenOnButton() {
      const [data, setData] = React.useState(snapshot);
      const [error, setError] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [open, setOpen] = React.useState(false);
      const [pos, setPos] = React.useState(null);
      const alive = React.useRef(true);
      const busyTimer = React.useRef(null);
      const rootRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const downAt = React.useRef(null);
      const lastTapAt = React.useRef(0);

      // 订阅模块级快照：页面只有一条轮询链，胶囊不再自己打 GET。
      React.useEffect(function () {
        alive.current = true;
        if (snapshot !== null) setData(snapshot);
        const unsubscribe = subscribe(function (next) {
          if (!alive.current) return;
          setData(next);
          setError("");
        });
        // 兜底：Host 长时间没有任何响应（轮询被系统节流/出错）才补拉一次。
        const handle = setInterval(function () {
          if (!alive.current) return;
          if (lastResponseAt === 0 || Date.now() - lastResponseAt > STALE_MS) requestSync();
        }, 5000);
        if (lastResponseAt === 0 || Date.now() - lastResponseAt > 3000) requestSync();
        return function () {
          alive.current = false;
          unsubscribe();
          clearInterval(handle);
          if (busyTimer.current !== null) {
            clearTimeout(busyTimer.current);
            busyTimer.current = null;
          }
        };
      }, []);

      // 打开后测量面板并摆位；窗口尺寸/滚动变化时重算。
      React.useLayoutEffect(function () {
        if (!open) {
          setPos(null);
          return;
        }
        const measure = function () {
          const next = computeMenuPos(rootRef, panelRef);
          if (next !== null) setPos(next);
        };
        measure();
        window.addEventListener("resize", measure);
        window.addEventListener("scroll", measure, true);
        return function () {
          window.removeEventListener("resize", measure);
          window.removeEventListener("scroll", measure, true);
        };
      }, [open]);

      // 点面板/按钮之外、按 Escape 关闭。
      React.useEffect(function () {
        if (!open) return;
        const onDown = function (event) {
          const target = event.target;
          if (rootRef.current !== null && rootRef.current.contains(target)) return;
          if (panelRef.current !== null && panelRef.current.contains(target)) return;
          setOpen(false);
        };
        const onKey = function (event) {
          if (event.key === "Escape") setOpen(false);
        };
        // pointerdown 为主，touchstart/mousedown 兜底老内核（重复触发是幂等的）。
        document.addEventListener("pointerdown", onDown, true);
        document.addEventListener("touchstart", onDown, true);
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keydown", onKey, true);
        return function () {
          document.removeEventListener("pointerdown", onDown, true);
          document.removeEventListener("touchstart", onDown, true);
          document.removeEventListener("mousedown", onDown, true);
          document.removeEventListener("keydown", onKey, true);
        };
      }, [open]);

      const mode = modeOf(data);
      const active = data !== null && data !== undefined && data.active === true;

      /** 选择一个模式：乐观更新 + 保护窗 + 6s 超时。 */
      const applyMode = React.useCallback(function (target) {
        // 新世代：点击前已发出的 GET 即使晚回来也作废，不许它把旧 mode 推回来。
        syncEpoch += 1;
        pendingMode = target;
        pendingUntil = Date.now() + PENDING_MS;
        setBusy(true);
        setError("");
        report(true, "pick:" + target);
        setData(function (previous) {
          const next = previous !== null && previous !== undefined
            ? Object.assign({}, previous)
            : { ok: true, enabled: true, mode: target, active: false, runningAgents: 0, liveJobs: 0 };
          next.mode = target;
          if (target === "always") next.active = true;
          if (target === "off") next.active = false;
          return next;
        });
        if (busyTimer.current !== null) clearTimeout(busyTimer.current);
        busyTimer.current = setTimeout(function () {
          busyTimer.current = null;
          if (alive.current) setBusy(false);
        }, BUSY_MS);
        const options = {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "set", mode: target }),
          cache: "no-store",
          credentials: "same-origin"
        };
        let controller = null;
        try {
          if (typeof AbortController === "function") {
            controller = new AbortController();
            options.signal = controller.signal;
          }
        } catch (ignored) {
          controller = null;
        }
        let watchdog = null;
        if (controller !== null) {
          watchdog = setTimeout(function () {
            try {
              controller.abort();
            } catch (ignored) {
              /* ignore */
            }
          }, BUSY_MS);
        }
        fetch(ROUTE, options)
          .then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
          })
          .then(function (payload) {
            if (watchdog !== null) {
              clearTimeout(watchdog);
              watchdog = null;
            }
            if (!alive.current) return;
            if (payload !== null && payload !== undefined && payload.ok === true && payload.mode === target) {
              pendingMode = "";
              pendingUntil = 0;
              snapshot = payload;
              snapshotAt = Date.now();
              lastResponseAt = Date.now();
              setData(payload);
              setError("");
              report(true, "ack:" + target);
              // 不等下一轮轮询：Host 说该常亮就立刻申请，该释放就立刻释放。
              if (payload.active === true) acquire();
              else release("ack");
            } else {
              pendingMode = "";
              pendingUntil = 0;
              setError("设置失败");
              report(true, "nack:" + target);
              requestSync();
            }
          })
          .catch(function (failure) {
            if (watchdog !== null) {
              clearTimeout(watchdog);
              watchdog = null;
            }
            if (!alive.current) return;
            pendingMode = "";
            pendingUntil = 0;
            setError(failure && failure.message ? failure.message : String(failure));
            report(true, "fail:" + target + (failure && failure.name ? ":" + failure.name : ""));
            requestSync();
          })
          .then(function () {
            if (busyTimer.current !== null) {
              clearTimeout(busyTimer.current);
              busyTimer.current = null;
            }
            if (alive.current) setBusy(false);
          });
      }, []);

      /** 点图标：开/关菜单（pointerup 与 click 都会来，去重）。 */
      const toggle = React.useCallback(function (event) {
        const now = Date.now();
        if (now - lastTapAt.current < TAP_DEDUPE_MS) return;
        lastTapAt.current = now;
        if (event !== undefined && event !== null) {
          try {
            event.preventDefault();
            event.stopPropagation();
          } catch (ignored) {
            /* ignore */
          }
        }
        setOpen(function (previous) {
          return !previous;
        });
      }, []);

      const onPointerDown = React.useCallback(function (event) {
        try {
          downAt.current = { x: event.clientX || 0, y: event.clientY || 0, at: Date.now() };
        } catch (ignored) {
          downAt.current = null;
        }
      }, []);

      // ArkWeb 上部分版本 click 合成不可靠，用 pointerup 兜底：
      // 按下去在按钮上、抬起位移 <12px 且 <900ms 才算一次点击。
      const onPointerUp = React.useCallback(function (event) {
        const down = downAt.current;
        downAt.current = null;
        if (down === null || down === undefined) return;
        if (Date.now() - down.at > 900) return;
        const dx = Math.abs((event.clientX || 0) - down.x);
        const dy = Math.abs((event.clientY || 0) - down.y);
        if (dx > 12 || dy > 12) return;
        toggle(event);
      }, [toggle]);

      // 状态文案（菜单顶部 + aria-label）。
      let hint = "任务时自动";
      let level = "";
      if (error !== "") {
        hint = "未就绪";
        level = "err";
      } else if (support === "unsupported") {
        hint = "不可用";
        level = "err";
      } else if (flaky) {
        hint = "支持但未生效";
        level = "warn";
      } else if (mode === "always") {
        hint = "强制中";
      } else if (mode === "off") {
        hint = "已关闭";
      } else {
        hint = active ? "任务中 · 常亮" : "任务时自动";
      }

      const helpText = support === "unsupported"
        ? "当前 WebView 没有 Screen Wake Lock API，纯插件方案在这里不适用；需要客户端桥（ArkTS setWindowKeepScreenOn）才能常亮。"
        : flaky
          ? "锁申请成功了，但页面可见时又被浏览器立刻释放 —— ArkWeb 可能没把常亮落到系统层。若屏幕仍会自动熄灭，需要改用客户端桥。"
          : inDshmClient
            ? "常亮靠 WebView 的 Screen Wake Lock：页面可见时生效；切到后台浏览器会自动释放，回到前台自动重新申请。"
            : "当前不在 DSHM 客户端内：常亮依赖浏览器的 Screen Wake Lock，页面可见时生效。";

      const IconComp = primitives !== undefined && primitives !== null ? primitives.IconLightOutlineMedium : undefined;
      const iconNode = typeof IconComp === "function"
        ? React.createElement(IconComp, {})
        : React.createElement("span", null, "☀");

      const pillClass = "dshmKsoPill"
        + (mode === "always" ? " on" : (active && level === "" ? " active" : ""))
        + (level === "" ? "" : " " + level);
      const ariaLabel = "屏幕常亮 · " + hint + " · 点按选择模式";

      const trigger = React.createElement("span", { className: "dshmKsoAnchor", ref: rootRef },
        React.createElement("button", {
          type: "button",
          className: pillClass,
          onClick: toggle,
          onPointerDown: onPointerDown,
          onPointerUp: onPointerUp,
          "aria-haspopup": "menu",
          "aria-expanded": open,
          "aria-label": ariaLabel,
          title: ariaLabel,
          "data-composer-stat": "keep-screen-on"
        },
          iconNode,
          React.createElement("span", { className: "dshmKsoDot", "aria-hidden": true })
        )
      );

      if (!open) return trigger;

      const menuStyle = pos === null
        ? { visibility: "hidden", left: 0, top: 0 }
        : { left: pos.left + "px", top: pos.top + "px" };

      const menu = React.createElement("div", {
        ref: panelRef,
        className: "dshmKsoMenu",
        role: "menu",
        "aria-label": "屏幕常亮",
        style: menuStyle
      },
        React.createElement("div", { className: "dshmKsoMenuHead" },
          React.createElement("span", { className: "dshmKsoMenuTitle" }, "屏幕常亮"),
          React.createElement("span", { className: "dshmKsoMenuState" + (level === "" ? "" : " " + level) },
            busy ? "设置中…" : hint)
        ),
        React.createElement("div", { className: "dshmKsoMenuRule", "aria-hidden": true }),
        MODE_ITEMS.map(function (item) {
          const checked = mode === item.mode;
          return React.createElement("button", {
            key: item.mode,
            type: "button",
            role: "menuitemradio",
            "aria-checked": checked,
            className: "dshmKsoMenuItem" + (checked ? " checked" : ""),
            onClick: function (event) {
              try {
                event.preventDefault();
                event.stopPropagation();
              } catch (ignored) {
                /* ignore */
              }
              setOpen(false);
              if (!checked) applyMode(item.mode);
            }
          },
            React.createElement("span", { className: "dshmKsoMenuItemLabel" }, item.label),
            React.createElement("span", { className: "dshmKsoMenuItemHint" }, item.hint),
            React.createElement("span", { className: "dshmKsoCheck", "aria-hidden": true },
              checked ? "✓" : "")
          );
        }),
        React.createElement("div", { className: "dshmKsoMenuNote" }, helpText)
      );

      const host = typeof document !== "undefined" ? document.body : null;
      if (host !== null && ReactDOM !== null && typeof ReactDOM.createPortal === "function") {
        return React.createElement(React.Fragment, null, trigger, ReactDOM.createPortal(menu, host));
      }
      return React.createElement(React.Fragment, null, trigger, menu);
    }

    /** 注册输入栏按钮；失败不影响屏幕常亮本身。 */
    function registerUi(ctx) {
      try {
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: zh, en: en });
        }, "dshm-keep-screen-on: dictionaries");
      } catch (error) {
        /* 文案失败不影响开关 */
      }
      try {
        ctx.effect(function () {
          return ctx.slots.inject("conversation.composer.dock", function () {
            return ctx.slots.register({
              name: "conversation.composer.dock",
              id: "keep-screen-on",
              order: 100,
              locale: NS
            }, ScreenOnButton);
          });
        }, "dshm-keep-screen-on: composer dock pill");
      } catch (error) {
        try {
          console.warn("[dshm-keep-screen-on] 输入栏按钮注册失败：", error && error.message ? error.message : error);
        } catch (ignored) {
          /* ignore */
        }
      }
    }

    /** cordis 客户端插件入口。 */
    function apply(ctx) {
      try {
        start();
      } catch (error) {
        try {
          console.warn("[dshm-keep-screen-on] 启动失败：", error && error.message ? error.message : error);
        } catch (ignored) {
          /* ignore */
        }
      }
      try {
        registerUi(ctx);
      } catch (error) {
        /* 界面失败不拖累屏幕常亮 */
      }
    }

    /** 需要 slots 才能把开关挂到底部；locale 用来注册文案。 */
    const inject = ["slots", "locale"];

    exports.apply = apply;
    exports.inject = inject;
    exports.ScreenOnButton = ScreenOnButton;
    exports.state = function () {
      return { support: support, state: state, held: sentinel !== null, stats: stats };
    };
    return module.exports;
  }
});
