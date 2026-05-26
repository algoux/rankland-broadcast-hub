# 公共部分

对于所有比赛交互请求，都需要先确定并准备好比赛的唯一标识符：**UCA**（Unique Contest Alias）。这样才能确定要访问的比赛。

大多数接口需要身份认证，如推流、观看、获取比赛信息等，都需要搭配鉴权密钥（token）实现访问。

### HTTP

对于 HTTP 方式的 API 交互，需携带以下请求头作为鉴权关键信息：

- `X-UCA` : 比赛 alias（Unique Contest Alias）
- `X-User-Id`: (optional) 部分接口可能需要，如选手端，目前暂不存在
- `X-Token`: (optional) 请求 token
- …其他字段

### Socket.io

对于 Socket.io 方式的交互，需要在连接初始化阶段就添加请求头（适用于 Node.js/Electron）或 query（适用于浏览器）来指定 UCA 等非敏感字段，token 类字段则需要放置于 auth 中。如果请求缺少必要字段或 token 不匹配，请求将会被拒绝。

请求头 + auth 的方式示例：

```tsx
io(url, {
  // ...
  extraHeaders: {
    "X-UCA": YOUR_UCA,
    "X-User-Id": YOUR_USER_ID, // optional
  },
  auth: {
    token: YOUR_TOKEN, // or other token fields
  },
});
```

query + auth 的方式示例：

```tsx
io(url, {
  // ...
  query: {
    "uca": UCA,
    "userId": YOUR_USER_ID, // optional
  },
  auth: {
    token: YOUR_TOKEN, // or other token fields
  },
});
```

字段都是小驼峰，只是在请求头上因符合规范所需，字段命名需要改为中划线风格（kebab-case）。

Socket.io 的交互方式是发送一个事件数据（emit），并可携带一个可选的请求数据（对于 JS，大多数情况发送一个接口需求的对象即可）。对方会响应 Resp 格式数据。无论谁向谁发送都是如此。

如果鉴权通过，则将被允许连接，你可以在 `connection` 触发后立即或随时发送事件进行交互。

因提供参数不对导致鉴权未通过的逻辑响应示例（在 `connect_error` 事件的第一个参数的 `data` 属性中获取）：

```json
{
  "success": false,
  "code": -5,
  "msg": "..."
}
```

### Resp 数据结构

成功结构：

- success: true
- code?: number // 如果有，必然为 0
- data?: any // 返回的响应数据，需要从这里取出数据，当做这次请求的回包（响应数据）

失败结构：

- success: false
- code?: number // 接口的逻辑返回码。用于有多种可能错误时，可用此 code 精确判断具体是哪类错误
- msg?: string // 接口失败的简要错误信息
- data?: any // 与失败相关的结构化数据
