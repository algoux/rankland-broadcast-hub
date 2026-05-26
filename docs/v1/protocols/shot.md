# 推流（Shot 端）

Shot 端通过 Socket.io 连接 Broadcast Hub Server。

nsp: `/shot`

### 鉴权

基础字段（请求头或 query）：

- `uca: string` : 比赛 alias

auth 字段：

- `id: string` : 客户端随机生成的唯一标识符，只要不重复即可
- `shotToken: string`: 机位推流密钥

### 主动事件：getContestInfo - 获取基本信息

向服务端请求比赛相关的基本信息。

请求参数：无

响应数据：

```tsx
{
  alias: string;
  contest: srk.Contest;
  serverTimestamp: number; // 服务端进行回包时的服务端毫秒时间戳，可以用于计算大概的 time diff
}
```

### 主动事件：confirmReady - 确认就绪

就绪时，发送自身必要的推流配置到服务端注册。

服务端会自动将此推流会话标记为 alive 状态，只有当对端发生 disconnect 或主动发送取消就绪时，才会解除 alive 状态。在 alive 状态时，服务端才会向导播端展示此机位是受控状态，并可能向此端下发控制事件。

一旦发生过 socket.io 断连、或 WebRTC transport 发生不可恢复的致命错误，并且此前是就绪状态，都需要在 socket 自动重连后，静默发送 confirmReady 事件并执行有关后续逻辑。但不需要在选手端静默地重新 produce。

服务端在收到此事件后，即会立刻登记信息到比赛存储，并为 WebRTC transport 执行初始化准备 。对 Shot 端来说，在这个事件收到回复后，需要立即根据返回参数开始建立 transport。

请求参数：

```tsx
{
	shotName: string; // 机位自设的人类可读的机位名称，用于导播端显示，不能与其他机位重复
  tracks: {
    trackId: string;
    name: string; // 此轨道的可读的名称，用于导播端显示
    type: 'video' | 'audio';
    // 其他推流配置中的必要字段
  }[]
}
```

响应数据：

```tsx
{
  transport: TransportOptions; // mediasoup 创建的 webrtc transport 中的必要字段组成的结构
  routerRtpCapabilities: RtpCapabilities; // mediasoup 返回的可用 rtpCapabilities
}
```

### 主动事件：completeConnectTransport - 完成连接 transport

在创建 transport 后，Shot 端自身需要根据 `transport.on('connect')` 回调中返回的参数，发送相关参数给服务端，为服务端侧连接 transport 做准备。服务端在收到此事件时，即最终进行完成连接操作。当服务端连接完成后会回复响应，可以在收到响应后，执行 transport 的 callback。

请求数据：

```tsx
{
  // 一些用于服务端 transport connect 的可选参数，如
  // dtlsParameters
}
```

响应数据：无

### 被动事件：requestStartBroadcast - 请求开始推流

服务端向 Shot 端发送的事件。意为要求开始推流。注意，此事件允许多次接收，Shot 端需要自身进行已推流轨道的去重和状态维护，避免同一个 track 重复 produce。

请求参数：

```tsx
{
  trackIds: string[]; // 需要的轨道 ID
}
```

响应数据：无

### 主动事件：produce - 推流

前提条件：完成 transport 连接（`completeConnectTransport` 已响应回复且没有错误）。

当需要开始推流时（如收到了 `requestStartBroadcast` 事件），调用 transport 启动推流，并在 `transport.on('produce')` 回调时发送一次事件给服务端。

请求参数：

```tsx
{
  trackId: string;
  kind: MediaKind;
  rtpParameters: RtpParameters;
}
```

响应数据：

```tsx
{
  producerId: string;
  type: ProducerType;
  appData: any;
}
```

### 被动事件：requestStopBroadcast - 请求结束推流

服务端向 Shot 端表示推流已 enough，不再需要推流了。需要在 Shot 端上关闭指定轨道的 producer，但不要关闭之前建立的 WebRTC transport。当已操作关闭 producer 后，发送空 callback 响应回复服务端。

请求参数：

```tsx
{
  trackIds: string[]; // 需要的轨道 ID
}
```

响应数据：无

### 主动事件：cancelReady - 取消就绪

取消就绪状态，解除在服务端的就绪注册并清理登记的 track 信息。如果已经开始推流，需要先进行相关 producer 和 transport 等的关闭和清理。

请求参数：无

响应数据：无
