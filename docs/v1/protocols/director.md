# 观看（导播端）

导播端通过 Socket.io 连接 Broadcast Hub Server。

nsp: `/broadcaster`

### 鉴权

基础字段（请求头或 query）：

- `uca: string` : 比赛 alias
- `userId: string` : 用户 ID

auth 字段：

- `directorToken: string`: 导播密钥

### 主动事件：joinBroadcastRoom - 加入推流房间

加入到推流房间，以获取到服务端创建的 transport。

请求参数：无

响应数据：

```tsx
{
  transport: Transport; // mediasoup 创建的 webrtc transport 中的必要字段组成的结构
  routerRtpCapabilities: RtpCapabilities; // mediasoup 返回的可用 rtpCapabilities
}
```

### 主动事件：completeConnectTransport - 完成连接 transport

在准备好消费时，导播端自身可以根据 `transport.on('connect')` 返回的一些参数，在连接到 transport 后，发送相关参数给服务端，为服务端侧连接 transport 做准备。服务端在收到此事件时，即开始连接。当服务端连接完成后，会回复响应，可以在收到响应后，完成 transport callback。

请求数据：

```tsx
{
  // 一些用于服务端 transport connect 的可选参数，如
  // dtlsParameters
}
```

响应数据：无

### 主动事件：startBroadcast - 请求推流

向服务端请求索取某个用户的推流。这将使服务端向指定推流用户发送消息，指使它开始所选轨道的推流。可以重复多次发送此事件，以开始其他轨道推流。

请求参数：

```tsx
{
  trackIds: string[];
}
```

响应数据：无

### 主动事件：consume - 消费

前提条件：完成 transport 连接（`completeConnectTransport` 已响应回复且没有错误）。

此事件的响应可以用于 `transport.consume()`。如果服务端判定无法消费，会返回逻辑错误。

请求参数：

```tsx
{
  trackId: string;
  rtpCapabilities: RtpCapabilities;
  paused?: boolean;
  preferredLayers?: ConsumerLayers;
}
```

响应数据：

```tsx
{
  consumerId: string;
  producerId: string;
  kind: MediaKind;
  rtpParameters: RtpParameters;
  type: ConsumerType;
  producerPaused: boolean;
  appData: any;
}
```

### 主动事件：stopBroadcast - 停止推流

向服务端告知，不再需要推流。这将使服务端向推流用户发送消息，指使它停止所选轨道的推流。可以重复多次发送此事件，以停止其他轨道推流。

请求参数：

```tsx
{
  trackIds: string[];
}
```

响应数据：无

### 被动事件（广播）：roomDestroyed - 推流房间已销毁

当因为推流方断连或取消就绪状态等原因导致房间被服务端销毁时会收到此事件。这意味着无法再请求推流或消费。如需重新请求，需要先检查 HTTP 接口的比赛内推流者状态，确定其已就绪，再重新请求 `joinBroadcastRoom` 。

请求参数：无

响应数据：无
