/**
 * dshm-keep-screen-on —— DSHM 屏幕常亮桥（Host 半部）。
 *
 * ── 要解决什么 ────────────────────────────────────────────────────────────
 * 手持档看长任务时屏幕按系统超时熄灭，得反复点亮。真正的「屏幕常亮」是
 * 系统窗口能力（ArkTS `window.setWindowKeepScreenOn`）或 W3C Screen Wake Lock
 * （`navigator.wakeLock.request("screen")`）。前者 Node 进程调不到，后者只有
 * **页面**（ArkWeb 里的 client.js）能调。
 *
 * ── 本插件怎么做 ──────────────────────────────────────────────────────────
 *   Host（本文件）
 *     · 每 3s 扫一遍活动：agents.list() 里 status==='running' 的 agent，
 *       以及 jobs.list()（无归属桶 + 每个 agent 会话的桶）里 running/stopping
 *       的后台任务
 *     · 活动结束后的宽限期（默认 60s）内仍然保持
 *     · 把结论暴露成 GET /dshm-keep-screen-on（active: true|false）
 *   Client（client.js，跑在 ArkWeb 页面里）
 *     · 轮询上面的状态；active 时 request Wake Lock，false 时 release
 *     · 页面隐藏时 Wake Lock 本来就会被浏览器释放，可见时重新申请
 *     · 把「ArkWeb 到底支不支持 / 申请成不成功」上报回来，写进日志与状态快照
 *
 * ── 设计取舍 ──────────────────────────────────────────────────────────────
 * · 不做设置页：默认 auto 模式已经覆盖「跑任务时别熄屏」的需求；要强制常亮
 *   或关闭，走 POST /dshm-keep-screen-on 的 set 动作（README 有例子）。
 * · 不做文件队列、不碰 ArkTS：这一版是纯插件方案，先验证 ArkWeb 的 Wake Lock。
 *   若实测 ArkWeb 不支持/不阻止熄屏，再按 dshm-keepalive 的文件队列模式补
 *   ArkTS 桥（见 README「方案 B」）。
 * · 所有失败只记日志，绝不影响宿主启动与 GUI。
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "dshm-keep-screen-on";

/** 需要 webServer 才能注册路由；活动扫描用 ctx.get 取 agents/jobs（可选服务）。 */
export const inject = ["webServer"];

/** 路由前缀（GET 状态 / POST 控制与上报）。 */
const ROUTE = "/dshm-keep-screen-on";
/** 活动扫描节拍。 */
const TICK_MS = 3000;
/** 宽限期默认值：最后一个任务结束后再保持多久。 */
const DEFAULT_GRACE_MS = 60_000;
/** 允许的三种模式。 */
const MODES = ["auto", "always", "off"];

/** 状态目录：$DSHM_HOME/screen-on（与 DSHM 其它桥同住一棵树）。 */
function dataDir(env = process.env) {
  const home = env.DSHM_HOME && env.DSHM_HOME.length > 0
    ? env.DSHM_HOME
    : env.DSH_HOME && env.DSH_HOME.length > 0
      ? env.DSH_HOME
      : join(homedir(), ".dsh");
  return join(home, "screen-on");
}

/** 原子写：读者永远看不到半截 JSON。 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeConfig(value) {
  const v = typeof value === "object" && value !== null ? value : {};
  const mode = typeof v.mode === "string" && MODES.includes(v.mode) ? v.mode : "auto";
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : true,
    mode,
    graceMs: Number.isFinite(v.graceMs)
      ? Math.min(1_800_000, Math.max(0, Math.round(v.graceMs)))
      : DEFAULT_GRACE_MS
  };
}

/**
 * 注册屏幕常亮桥。
 *
 * @param ctx - cordis 上下文（inject: webServer）
 */
export function apply(ctx) {
  const dir = dataDir();
  const logFile = join(dir, "screen-on.log");
  const configFile = join(dir, "config.json");

  function log(line) {
    try {
      mkdirSync(dir, { recursive: true });
      // 日志只追加、不轮转就会无限长：超过 256KB 先滚一份 .1（旧的 .1 直接覆盖）。
      try {
        if (statSync(logFile).size > 256 * 1024) renameSync(logFile, `${logFile}.1`);
      } catch {
        /* 文件还不存在（第一次写） */
      }
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, "utf8");
    } catch {
      /* 诊断失败不影响主流程 */
    }
  }

  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    log(`状态目录创建失败：${errorMessage(error)}`);
  }

  /** 配置（内存 + config.json 持久化；改完即时生效）。 */
  const config = normalizeConfig(readJson(configFile));

  /** 活动计数（每拍重算）。 */
  let runningAgents = 0;
  let liveJobs = 0;
  /** 最近一次「有活动」的时刻（宽限期基准）。 */
  let lastLiveAt = 0;
  /** 当前是否要求页面常亮（Host 判定）。 */
  let active = false;
  /** 最近一次 client 上报（ArkWeb 的 Wake Lock 支持与持有状态）。 */
  let client = null;
  /** 上一次活动扫描的时刻（GET 轮询只做节流后的重算，别让每次请求都全量扫）。 */
  let lastTickAt = 0;

  /** 取服务实例；服务不存在/还没注册时返回 undefined。 */
  function service(key) {
    try {
      return ctx.get(key);
    } catch {
      return undefined;
    }
  }

  /** 扫活动：运行中的 agent + 运行中的后台任务（含各自归属桶）。 */
  function scanActivity() {
    let agents = 0;
    const list = [];
    const agentsSvc = service("agents");
    if (agentsSvc !== undefined && typeof agentsSvc.list === "function") {
      try {
        const rows = agentsSvc.list();
        if (Array.isArray(rows)) {
          for (const row of rows) {
            if (row !== null && row !== undefined && row.status === "running") agents += 1;
            list.push(row);
          }
        }
      } catch {
        /* 服务正在卸载：按无活动处理 */
      }
    }
    let jobs = 0;
    const jobsSvc = service("jobs");
    if (jobsSvc !== undefined && typeof jobsSvc.list === "function") {
      const seen = new Map();
      const add = (rows) => {
        if (!Array.isArray(rows)) return;
        for (const job of rows) {
          if (job !== null && job !== undefined && typeof job.id === "string") seen.set(job.id, job);
        }
      };
      try {
        add(jobsSvc.list());
      } catch {
        /* ignore */
      }
      // jobs.list() / jobs.list(caller) 在 dsh-jobs-local 里都是**纯内存过滤**（不落盘），
      // 所以按会话补查全部 agent 的成本可以接受；漏查会让 liveJobs 偏少，
      // 进而让 auto 模式提前释放常亮。
      for (const row of list) {
        if (row === null || row === undefined) continue;
        const caller = typeof row.sessionId === "string"
          ? row.sessionId
          : (typeof row.id === "string" ? row.id : undefined);
        if (caller === undefined) continue;
        try {
          add(jobsSvc.list(caller));
        } catch {
          /* ignore */
        }
      }
      for (const job of seen.values()) {
        if (job.status === "running" || job.status === "stopping") jobs += 1;
      }
    }
    runningAgents = agents;
    liveJobs = jobs;
  }

  /** 当前是否要让页面保持常亮。 */
  function wantsHold(now) {
    if (!config.enabled) return false;
    if (config.mode === "always") return true;
    if (config.mode === "off") return false;
    if (runningAgents > 0 || liveJobs > 0) return true;
    return lastLiveAt > 0 && now - lastLiveAt < config.graceMs;
  }

  function tick(force) {
    try {
      const now = Date.now();
      // GET 轮询会频繁进来（页面里的 sync + 胶囊各一份），但活动扫描是同步落盘的重活：
      // 1s 内只重算一次，节拍另有 3s 定时器兜底。
      if (force !== true && lastTickAt > 0 && now - lastTickAt < 1000) return;
      lastTickAt = now;
      scanActivity();
      if (runningAgents > 0 || liveJobs > 0) lastLiveAt = now;
      const next = wantsHold(now);
      if (next !== active) {
        active = next;
        log(`常亮${active ? "开启" : "关闭"}（agents=${runningAgents}，jobs=${liveJobs}，mode=${config.mode}，grace=${config.graceMs}ms）`);
      }
    } catch (error) {
      log(`tick 异常：${errorMessage(error)}`);
    }
  }

  // 节拍挂在 ctx.effect 上：插件停用/重载时定时器跟着销毁，不会叠加多条扫描链。
  try {
    ctx.effect(() => {
      const handle = setInterval(() => tick(true), TICK_MS);
      if (typeof handle.unref === "function") handle.unref();
      return () => clearInterval(handle);
    }, "dshm-keep-screen-on: tick");
  } catch (error) {
    log(`节拍注册失败：${errorMessage(error)}`);
  }
  tick(true);
  log(`屏幕常亮桥已加载：dir=${dir}；mode=${config.mode}；节拍=${TICK_MS}ms`);

  function snapshot() {
    const now = Date.now();
    // mode=always 是用户明示的「强制常亮」：即使某一拍扫描抛错，也要如实告诉页面该常亮，
    // 否则页面只按 mode 显示「强制」却不去申请 Wake Lock。
    const hold = config.enabled && config.mode === "always" ? true : active;
    return {
      ok: true,
      dir,
      route: ROUTE,
      active: hold,
      enabled: config.enabled,
      mode: config.mode,
      graceMs: config.graceMs,
      runningAgents,
      liveJobs,
      idleMs: lastLiveAt > 0 ? now - lastLiveAt : null,
      client: client === null
        ? null
        : {
            support: client.support,
            state: client.state,
            detail: client.detail,
            ageMs: now - client.at
          },
      at: new Date().toISOString()
    };
  }

  function sameOrigin(req) {
    const origin = req.headers?.origin;
    if (typeof origin !== "string" || origin === "") return true; // 同源导航/测试客户端
    try {
      const host = String(req.headers?.host ?? "");
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  function json(res, status, payload) {
    try {
      const body = `${JSON.stringify(payload)}\n`;
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store"
      });
      res.end(body);
    } catch {
      /* 连接可能已断 */
    }
  }

  function readBody(req) {
    return new Promise((done) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 64 * 1024) raw = raw.slice(0, 64 * 1024);
      });
      req.on("end", () => {
        try {
          done(JSON.parse(raw));
        } catch {
          done({});
        }
      });
      req.on("error", () => done({}));
    });
  }

  /** client 上报：支持能力 + 持有状态；只在变化时写日志。 */
  function recordReport(body) {
    const next = {
      support: typeof body.support === "string" ? body.support.slice(0, 40) : "unknown",
      state: typeof body.state === "string" ? body.state.slice(0, 40) : "unknown",
      detail: typeof body.detail === "string" ? body.detail.slice(0, 200) : "",
      at: Date.now()
    };
    const changed = client === null || client.support !== next.support || client.state !== next.state
      || client.detail !== next.detail;
    client = next;
    if (changed) {
      log(`页面上报：support=${next.support} state=${next.state}${next.detail === "" ? "" : ` detail=${next.detail}`}`);
    }
  }

  const route = {
    kind: "exact",
    path: ROUTE,
    async handler(req, res) {
      if (!sameOrigin(req)) {
        json(res, 403, { ok: false, error: "cross-site request rejected" });
        return;
      }
      try {
        if (req.method === "GET") {
          tick();
          json(res, 200, snapshot());
          return;
        }
        if (req.method !== "POST") {
          json(res, 405, { ok: false, error: `method not allowed: ${req.method}` });
          return;
        }
        const body = await readBody(req);
        const action = typeof body.action === "string" ? body.action : "";

        if (action === "report") {
          recordReport(body);
          json(res, 200, { ok: true, active, mode: config.mode });
          return;
        }

        if (action === "set") {
          const before = JSON.stringify(config);
          if (typeof body.mode === "string" && MODES.includes(body.mode)) config.mode = body.mode;
          if (typeof body.enabled === "boolean") config.enabled = body.enabled;
          if (Number.isFinite(body.graceMs)) {
            config.graceMs = Math.min(1_800_000, Math.max(0, Math.round(body.graceMs)));
          }
          let persisted = true;
          try {
            writeJsonAtomic(configFile, config);
          } catch (error) {
            persisted = false;
            log(`写配置失败：${errorMessage(error)}`);
          }
          if (JSON.stringify(config) !== before) {
            log(`配置变更：enabled=${config.enabled} mode=${config.mode} grace=${config.graceMs}ms`);
          }
          tick(true);
          json(res, 200, { ...snapshot(), persisted });
          return;
        }

        if (action === "ping") {
          json(res, 200, { ok: true, active, mode: config.mode });
          return;
        }

        json(res, 400, { ok: false, error: `unknown action: ${action === "" ? "(empty)" : action}` });
      } catch (error) {
        json(res, 500, { ok: false, error: errorMessage(error) });
      }
    }
  };

  try {
    ctx.effect(() => ctx.webServer.register(route), "dshm-keep-screen-on: route");
  } catch (error) {
    log(`路由注册失败：${errorMessage(error)}`);
  }
}
