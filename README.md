# dshm-keep-screen-on（屏幕常亮桥）

> 一句话：**agent / 后台任务在跑的时候，让 ArkWeb 页面持有 Screen Wake Lock，
> 手机不再按系统超时熄屏；输入框下方的用量栏里有一个图标按钮，点开就能选常亮模式。**

这是「纯插件方案」：不碰 ArkTS、不改客户端，靠页面里标准的
`navigator.wakeLock.request("screen")` 实现。已在真机验证 ArkWeb 支持该 API
（`support=ok`，申请成功）。

---

## 安装

```bash
# DSHM 端侧（没有真 pnpm，命令由 Host 的假壳接住，同步返回安装结果）
pnpm add github.com/yinghan-123/dshm-keep-screen-on
```

（也可以在 设置 → 插件 的「安装插件」输入框里填同样的
`github.com/yinghan-123/dshm-keep-screen-on`，效果相同。）

装完 **划掉后台重开 DSHM**（客户端 bundle 只在启动时扫描）。

卸载：设置 → 插件 → 卸载 `dshm-keep-screen-on`，再重开。

---

## 用量栏胶囊

DSH 输入框下方那排用量胶囊（`conversation.composer.dock`：回合/速度、Token 用量、上下文占用）
里多了一个「屏幕常亮」**图标按钮**，和它们同款同排。

**点图标 → 弹出菜单**：

| 菜单项 | 含义 |
| --- | --- |
| 强制常亮 | mode `always`：不管有没有任务，一直常亮 |
| 任务时自动 | mode `auto`（默认）：有 agent/后台任务在跑才常亮，全部结束宽限 60s 释放 |
| 关闭 | mode `off`：本插件不申请常亮 |

当前模式打勾；菜单顶部实时显示状态（`强制中` / `任务中 · 常亮` / `已关闭` /
`支持但未生效` / `未就绪`），底部一句适配说明。点菜单外或按 Escape 关闭。

### 为什么只有图标（v0.2.1）

手机窄屏下 `conversation.composer.dock` 空间紧张：宿主自己的用量胶囊在
`@media (width<=480px)` 里就隐藏了文字（`TurnUsagePanel` 的 `.label{display:none}`），
本插件的胶囊文字同样被 flex 压掉，只剩图标 —— 用户看不出当前是哪种模式。
所以改成「图标按钮 + 菜单」：状态与选项全部进菜单，胶囊本身只保留图标 + 状态色
（品牌色 = 强制/常亮中，警示色 = 未生效/未就绪）和右上角一个小状态点。

### v0.2.1（2026-10-25，交互改版）

真机反馈「开关只有图标、没有说明文字」：窄屏下胶囊文字被 flex 压掉（见上节），
看不出现状。改成「图标按钮 + 弹出菜单」：菜单里三个模式明确可选、当前项打勾、
顶部显示实时状态，底部给适配说明；不再依赖胶囊文字表达状态。

实现要点：菜单用 `react-dom.createPortal` 挂到 `document.body`（宿主统计弹层同款），
`position:fixed` + 手写视口夹取定位（按钮正上方，放不下翻到下方）；
`pointerdown`/`touchstart`/`mousedown`（捕获阶段）+ Escape 关闭；
选择模式沿用 v0.2.0 的乐观更新 + 8s 保护窗 + ack 后立即申请/释放。

### v0.2.0 修复（2026-10-25）

真机症状：**点胶囊没反应，或者刚变成「强制」又自己跳回「常亮」**。定位到四处：

1. 页面里有两个轮询链（`start()` 的 4s + 胶囊自己的 5s），每次都打 GET，
   Host 侧每个 GET 还触发一次全量活动扫描 —— 点击响应被拖慢，日志里 `/dshm-keep-screen-on`
   一秒能出现十来条。
2. 胶囊被宿主 `Tooltip` 包裹，点击依赖 Tooltip 转发 `cloneElement` 的事件；这条链在
   ArkWeb 上不可靠（点了完全没有 POST 出去）。
3. 点击后的乐观值会被 5s 后的轮询结果无条件覆盖，而轮询拿到的是「还没改」的 Host 状态
   ⇒ 视觉上就是「状态又跳回去」。
4. `busy` 只在 fetch 的最后一个 then 里复位；请求一旦挂住，后续点击全被
   `if (busy) return` 吞掉，表现为「点了没反应」。

现在的做法：

- 整页**只有一条** 8s 轮询链（`sync()`），快照进模块级缓存，胶囊订阅缓存，不再自己打接口；
- 点击直接绑在 `<button>` 上（`onClick` + `onPointerUp` 兜底，1000ms 去重、位移 >12px 不算点击），
  不再经过 Tooltip；
- 点击后进入 8s **保护窗**：轮询拿回的旧 mode 不覆盖用户刚点的选择，等 Host 明确确认
  （返回 `mode === 目标`）或超时才回滚；
- POST 带 `AbortController` 与 6s 超时，`busy` 有独立计时器，绝不会永久卡住；
- 每次点击 / 成功 / 失败都 `report` 到 Host：日志里出现
  `页面上报：support=ok state=held detail=tap:always` 这种行，就说明点击真的到了；
- Host 侧 GET 的活动扫描节流到 1s 一次，避免每来一个 GET 就全量扫一遍。

诊断（页面控制台）：`__dshmKeepScreenOn()` 现在还会返回 `mode` / `active` /
`snapshotAgeMs` / `pendingMode` / `pollErrors`，能直接看出是「没拿到 Host 状态」
还是「点击没送到」。


### 外观与适配提示

胶囊文案保持短且稳定（避免宽度变化把整排用量胶囊推来推去），状态靠颜色区分：

| 显示 | 颜色 | 含义 |
| --- | --- | --- |
| `常亮` | 三级灰 | 支持，空闲（任务开始时自动亮） |
| `常亮` | 品牌色 | 支持，正在常亮中（自动触发） |
| `强制` | 品牌色 + 淡底 | 强制常亮中（点它切回自动） |
| `未生效` | 警示黄 | 支持但系统没接受（ArkWeb 没把锁落到系统层） |
| `不可用` | 警示红 | 当前 WebView 没有 Wake Lock API |
| `未就绪` | 警示红 | 拉不到 Host 状态（插件没起 / 宿主重启中） |

完整结论与原因在 `title` / `aria-label` 里（移动端长按可见），胶囊本身还带 `aria-pressed`。

## 默认行为

| 条件 | 页面行为 |
| --- | --- |
| 有 `status === "running"` 的 agent（主 agent / subagent / workflow 子代理） | 持有 Wake Lock（屏幕常亮） |
| 有 `running` / `stopping` 的后台任务（`run_in_background` 命令、后台 subagent） | 同上 |
| 最后一个任务结束 | 再保持 `graceMs`（默认 60s）后释放 |
| 页面切到后台 | 浏览器自动释放，回前台重新申请 |
| 页面关掉 / DSHM 退出 | 随页面一起消失，不会留下任何系统级残留 |

---

## 手动控制

页面控制台：

```js
__dshmKeepScreenOn()                  // 看支持情况与当前状态
__dshmKeepScreenOn.mode('always')     // 强制常亮
__dshmKeepScreenOn.mode('auto')       // 任务时自动
__dshmKeepScreenOn.mode('off')        // 关闭本插件
```

或者直接打 HTTP：

```js
fetch('/dshm-keep-screen-on', { method:'POST', headers:{'content-type':'application/json'},
  body: JSON.stringify({ action:'set', mode:'always' }) }).then(r=>r.json()).then(console.log)
```

---

## HTTP 端点（同源；`Origin` 与 `Host` 不一致时 403）

### `GET /dshm-keep-screen-on`

```json
{
  "ok": true,
  "dir": "$DSH_HOME/screen-on",
  "active": true,
  "enabled": true,
  "mode": "auto",
  "graceMs": 60000,
  "runningAgents": 1,
  "liveJobs": 0,
  "idleMs": 0,
  "client": { "support": "ok", "state": "held", "detail": "", "ageMs": 1200 }
}
```

`client` 是页面最近一次上报的结论：

| 字段 | 含义 |
| --- | --- |
| `support: "ok"` | ArkWeb 暴露了 `navigator.wakeLock`（本机实测为 ok） |
| `support: "unsupported"` | ArkWeb 没有这个 API（本机不会出现） |
| `state: "held"` | Wake Lock 已持有，屏幕应当常亮 |
| `state: "denied:NotAllowedError"` | 页面调了但被拒绝（原因在 `detail`） |
| `state: "released"` | 已释放（任务结束/页面隐藏，`detail` 说明原因） |

### `POST /dshm-keep-screen-on`

| 身体 | 含义 |
| --- | --- |
| `{"action":"report","support":"ok","state":"held","detail":""}` | 页面上报（client.js 自动发） |
| `{"action":"set","mode":"auto"\|"always"\|"off"}` | 改模式（用量栏胶囊用的就是它） |
| `{"action":"set","enabled":false}` / `{"action":"set","graceMs":120000}` | 关总开关 / 改宽限期 |
| `{"action":"ping"}` | 轻量探活 |

---

## 验证（真机，已通过部分）

1. 打开 DSH 页面，输入框下方用量栏出现「屏幕常亮」胶囊；页面控制台 `__dshmKeepScreenOn()`：
   期望 `support: "ok"`。
2. 让 agent 跑一个 > 2 分钟的任务，或点胶囊切到「强制」（强制常亮），
   放置到超过系统自动熄屏时间。
3. 判据：
   - 屏幕一直亮 ⇒ 方案成立；
   - 状态是 `held` 但屏幕仍然熄灭 ⇒ ArkWeb 拿到了锁却没落到系统层，
     此时走「方案 B」（ArkTS 桥 `window.setWindowKeepScreenOn`）。

日志：`$DSH_HOME/screen-on/screen-on.log`，里面有
`页面上报：support=… state=…` 与每次 `常亮开启/关闭` 的记录。

---

## 方案 B（如果 ArkWeb 不认账）

按工作区里 `移动端后台任务-长时任务` 的 KeepAliveBridge 同名套路做一个
`KeepScreenOnBridge.ets`：

- Host 半部把 `active` 写成 `$DSH_HOME/screen-on/req/<id>.req`；
- ArkTS 侧轮询该目录，`window.getLastWindow(ctx).then(w => w.setWindowKeepScreenOn(true))`；
- 回执写 `done/<id>.done`，释放时 `setWindowKeepScreenOn(false)`。

本插件已经把这套状态机需要的「活动判定 + 宽限期 + 幂等」都写好了，
届时只需在 `lib/index.js` 里加一个文件队列出口，client.js 可以退化成纯诊断。

---

## 结构

```
dshm-keep-screen-on/
├── package.json
├── cordis.patch.yml        ← 挂载一行 loader（bundle patch）
├── lib/index.js            ← Host：活动检测 + 宽限期 + HTTP 路由 + 状态上报
├── client.js               ← 页面：Wake Lock 申请/释放 + 用量栏胶囊 UI
└── README.md
```

## 边界

- 只覆盖「屏幕自动熄灭」，不管后台冻结（那是 `dshm-keepalive` 的事）。
- 页面切后台后浏览器会释放锁，所以它保的是「你正看着页面的时候」。
- 不修改任何 DSH 行为，也不写系统设置。
