import { registerErrCodeConfigs } from '@server/err-code-configs';
import { ErrCode } from '@common/enums/err-code.enum';

registerErrCodeConfigs({
  [ErrCode.SystemError]: '系统异常，请稍后再试',
  [ErrCode.IllegalRequest]: '非法请求',
  [ErrCode.IllegalParameters]: '非法参数',
  [ErrCode.Unauthorized]: '未授权的操作',
  [ErrCode.InvalidAuthInfo]: '未能授权，因为提供的信息错误',

  // LiveContest
  [ErrCode.LiveContestExisted]: '该比赛已存在',
  [ErrCode.LiveContestNotFound]: '该比赛未找到',
  [ErrCode.LiveContestMemberNotFound]: '该比赛成员未找到',

  // Broadcast
  [ErrCode.BroadcastNotReady]: '推流未就绪',
  [ErrCode.BroadcastMediaRoomBroken]: '推流媒体房间未知异常',
  [ErrCode.BroadcastMediaRoomPeerMissing]: '推流媒体房间 Peer 信息丢失',
  [ErrCode.BroadcastMediaRoomRequiredTrackMissing]: '所请求的推流轨道信息丢失',
  [ErrCode.BroadcastMediaRoomCannotConsume]: '无法消费所请求的推流轨道',

  // Highlight Replay
  [ErrCode.ClipAutomationNotFound]: '精彩回放自动化任务未找到',
  [ErrCode.ClipAutomationInvalidTrigger]: '精彩回放自动化触发配置非法',
  [ErrCode.ClipTaskNotFound]: '精彩回放任务未找到',
  [ErrCode.ClipTaskInvalidTimeWindow]: '精彩回放时间窗口非法',
  [ErrCode.ClipTaskTargetOffline]: '精彩回放目标选手端离线',
  [ErrCode.ClipTaskTrackNotFound]: '精彩回放目标轨道未找到',
  [ErrCode.ClipTaskRecordingRangeMissing]: '选手端本地录制无法覆盖请求时间窗',
  [ErrCode.ClipUploadNotFound]: '精彩回放上传会话未找到',
  [ErrCode.ClipUploadOffsetMismatch]: '精彩回放上传偏移不一致',
  [ErrCode.ClipUploadChecksumMismatch]: '精彩回放上传校验和不一致',
  [ErrCode.ClipUploadExpired]: '精彩回放上传会话已过期',
  [ErrCode.ClipMediaValidationFailed]: '精彩回放媒体文件校验失败',
  [ErrCode.ClipNotFound]: '精彩回放切片未找到',
  [ErrCode.ClipMediaRangeNotSatisfiable]: '精彩回放媒体 Range 不可满足',
});
