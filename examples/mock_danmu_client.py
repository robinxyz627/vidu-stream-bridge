#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Vidu S2 数字人弹幕中继 - 外部模拟客户端 (Mock Danmu Client)
用于向 Vidu S2 工作台 (http://<host>:8010/human) 推送模拟弹幕与互动事件。
依赖：仅使用 Python3 标准库，无需额外 pip 安装。
"""

import sys
import json
import argparse
import urllib.request
import urllib.error

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8010

def send_danmu_event(event_data, host=DEFAULT_HOST, port=DEFAULT_PORT):
    url = f"http://{host}:{port}/human"
    body = json.dumps(event_data, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            status = resp.status
            res_body = resp.read().decode("utf-8", errors="ignore")
            print(f"[OK {status}] 成功发送事件 [{event_data.get('type')}]: {res_body}")
            return True
    except urllib.error.URLError as e:
        print(f"[ERROR] 连接中继失败 ({url}): {e.reason}")
        print("💡 提示：请确保 Vidu S2 桌面端已启动且弹幕接管处于开启状态！")
        return False
    except Exception as e:
        print(f"[ERROR] 发送异常: {e}")
        return False

def main():
    parser = argparse.ArgumentParser(description="Vidu S2 数字人弹幕推送测试工具")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"目标主机 IP / 域名 (默认: {DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"目标端口 (默认: {DEFAULT_PORT})")
    parser.add_argument("--type", choices=["chat", "gift", "follow", "enter", "like"], default="chat", help="事件类型")
    parser.add_argument("--nickname", default="热心观众", help="观众昵称")
    parser.add_argument("--gender", choices=["男", "女", "未知"], default="女", help="观众性别")
    parser.add_argument("--content", default="", help="弹幕发言内容 (chat 类型必填)")
    parser.add_argument("--gift-name", default="小心心", help="礼物名称 (gift 类型)")
    parser.add_argument("--gift-count", type=int, default=1, help="礼物数量")
    parser.add_argument("--diamonds", type=int, default=1, help="礼物抖币价值 (>=50 自动判定为大额礼物)")
    parser.add_argument("--count", type=int, default=10, help="点赞数 (like 类型)")
    parser.add_argument("--demo", action="store_true", help="连续运行全事件 Demo 演示 (聊天、水词过滤、大额打赏、关注、时间提问)")

    args = parser.parse_args()

    if args.demo:
        import time
        print(f"=== 开始全事件 Demo 演示 -> http://{args.host}:{args.port}/human ===")
        events = [
            {"type": "chat", "nickname": "小明", "gender": "男", "content": "主播好，今天穿得真可爱！"},
            {"type": "chat", "nickname": "水军", "gender": "男", "content": "666"},
            {"type": "gift", "nickname": "榜一大哥", "gender": "男", "giftName": "嘉年华", "giftCount": 1, "diamondCount": 3000},
            {"type": "follow", "nickname": "甜心小喵", "gender": "女"},
            {"type": "chat", "nickname": "时间询问者", "gender": "女", "content": "现在几点钟啦？"},
        ]
        for idx, ev in enumerate(events, start=1):
            print(f"\n[{idx}/{len(events)}] 投递事件: {ev}")
            send_danmu_event(ev, host=args.host, port=args.port)
            time.sleep(1.2)
        print("\n=== Demo 演示完成 ===")
        return

    # 单条发送
    if args.type == "chat":
        content = args.content or "主播你好呀！"
        ev = {"type": "chat", "nickname": args.nickname, "gender": args.gender, "content": content}
    elif args.type == "gift":
        ev = {
            "type": "gift",
            "nickname": args.nickname,
            "gender": args.gender,
            "giftName": args.gift_name,
            "giftCount": args.gift_count,
            "diamondCount": args.diamonds
        }
    elif args.type == "follow":
        ev = {"type": "follow", "nickname": args.nickname, "gender": args.gender}
    elif args.type == "enter":
        ev = {"type": "enter", "nickname": args.nickname, "gender": args.gender}
    elif args.type == "like":
        ev = {"type": "like", "nickname": args.nickname, "gender": args.gender, "count": args.count}

    send_danmu_event(ev, host=args.host, port=args.port)

if __name__ == "__main__":
    main()
