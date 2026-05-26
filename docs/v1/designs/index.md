# Kessoku Series

Kessoku Series 产品是专注于算竞赛事的直播导播工具套件。

目前包含以下组件：
- 选手端（Kessoku the Broadcaster，简称 KtB）：选手机器上安装的应用，在比赛时静默后台录制如摄像头、屏幕、麦克风等音视频流，接收服务端命令管理实时推流
- 导播端（Kessoku the Overlay, KtO）：提供导播界面和专业生产力工具，提供包括赛事榜单、实时提交滚动、推流画面等用于 OBS 等直播软件的叠加画面，支持多机位画面布局和切换
- Shot 端（Kessoku the Shot, KtS）：提供灵活的额外现场多机位画面作为导播软件的补充
- RankLand Broadcast Hub 服务端：负责选手端和导播端的信令、SFU 服务端承载，包括推流的连接、协调和管理，提供 API
- RankLand Web 服务端：提供比赛核心信息的查询和管理 API

## 设计文档

- [KtB（选手端）设计文档](./ktb.md)
- [精彩回放设计文档](./highlight-replay.md)
