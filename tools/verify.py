"""屏幕常亮插件现场体检：重开 DSHM 后跑一次，看「新版本是否加载 / 点击是否到 Host」。

用法：
    python verify.py

看三处：
1. $DSH_HOME/screen-on/screen-on.log —— Host 侧插件自己写的日志；
   出现 `detail=mount` = 新版 client.js 跑起来了；
   出现 `detail=tap:always` / `tap:auto` = 点击事件确实到了按钮；
   出现 `配置变更：… mode=…` = POST set 真的改了配置。
2. $DSH_HOME/../dshm-host.log —— HTTP 访问日志（尾部若干行）；
   `/plugins/??dshm-keep-screen-on/client.js&rev=…` = 页面拉取客户端 bundle；
   `POST /dshm-keep-screen-on … status=200` = 控制请求到了 Host。
3. $DSH_HOME/screen-on/config.json —— 当前持久化的模式。
"""

import json
import os

DSH_HOME = os.environ.get("DSHM_HOME") or os.environ.get("DSH_HOME") or ""
if not DSH_HOME:
    DSH_HOME = "/data/storage/el2/base/haps/entry/files/dsh/home"
SCREEN_DIR = os.path.join(DSH_HOME, "screen-on")
HOST_LOG = os.path.join(os.path.dirname(DSH_HOME), "dshm-host.log")

TAIL_BYTES = 400_000
NEEDLES = ("/dshm-keep-screen-on", "dshm-keep-screen-on/client.js")


def read_tail(path, size):
    if not os.path.exists(path):
        return ""
    with open(path, "rb") as handle:
        handle.seek(max(0, os.path.getsize(path) - size))
        return handle.read().decode("utf-8", "replace")


def main():
    print("=" * 70)
    print("1) 插件自己的日志：", os.path.join(SCREEN_DIR, "screen-on.log"))
    log_path = os.path.join(SCREEN_DIR, "screen-on.log")
    if os.path.exists(log_path):
        lines = open(log_path, encoding="utf-8", errors="replace").read().splitlines()
        print(f"   共 {len(lines)} 行，最后 25 行：")
        for line in lines[-25:]:
            print("   ", line)
        joined = "\n".join(lines)
        print("   · mount 上报：", "有" if "detail=mount" in joined else "无（新版 client.js 没跑起来）")
        taps = [l for l in lines if "detail=tap:" in l]
        print(f"   · tap 上报：{len(taps)} 条")
        for line in taps[-5:]:
            print("     ", line)
    else:
        print("   不存在（插件没加载过）")

    print("=" * 70)
    print("2) 当前配置：", os.path.join(SCREEN_DIR, "config.json"))
    cfg = os.path.join(SCREEN_DIR, "config.json")
    if os.path.exists(cfg):
        try:
            print("   ", json.load(open(cfg, encoding="utf-8")))
        except Exception as error:  # noqa: BLE001
            print("    解析失败：", error)
    else:
        print("   不存在")

    print("=" * 70)
    print("3) Host HTTP 日志尾部（只看与本插件相关的行）：", HOST_LOG)
    tail = read_tail(HOST_LOG, TAIL_BYTES)
    hits = [l for l in tail.splitlines() if any(n in l for n in NEEDLES)]
    print(f"   尾部 {len(tail)} 字节里命中 {len(hits)} 行，最后 30 行：")
    for line in hits[-30:]:
        print("   ", line[:220])
    posts = [l for l in hits if "POST /dshm-keep-screen-on" in l and "IN-REQ" in l]
    print(f"   · 尾部 POST 次数：{len(posts)}")
    bundles = [l for l in hits if "client.js" in l and "IN-DONE" in l]
    if bundles:
        print("   · 最近一次 bundle 拉取：", bundles[-1][:200])


if __name__ == "__main__":
    main()
