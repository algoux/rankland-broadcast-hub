# 接口协议（v1）

RL Broadcast Hub 是类似 RL Web 的 Node.js 服务端，主要负责提供与推流/导播观看相关的逻辑。因其承担 SFU 架构的 server 职责，所以需要具备一定入站带宽（推流），以及出站带宽（对应导播观看）的基本要求，因此其也允许主办方自行部署。在 self host 模式下，它本身不直连 RL 数据库，而是通过 HTTP API 请求到公网的 RL Web 服务器以获取比赛配置等信息。

推流相关的特定字段依然存储在 RL 数据库，Broadcaster 服务端只处理业务逻辑和流量转发。

- [公共部分](./common.md)
- [推流（选手端）](./broadcaster.md)
- [推流（Shot 端）](./shot.md)
- [观看（导播端）](./director.md)
- [精彩回放](./highlight-replay.md)
