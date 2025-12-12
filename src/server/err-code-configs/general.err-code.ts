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
});
