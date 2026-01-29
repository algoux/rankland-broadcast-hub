import { FromQuery } from 'bwcx-common';
import { IsNotEmpty, IsString } from 'class-validator';

export class GetContestAllBroadcasterInfoReqDTO {
  @FromQuery()
  @IsString()
  @IsNotEmpty()
  public uca: string;
}

export class GetContestAllBroadcasterInfoRespDTOItem {
  public status: 'ready' | 'broadcasting';
  public tracks: {
    trackId: string;
    type: 'screen' | 'camera' | 'microphone';
  }[];
  public broadcastingTrackIds: string[];
}

export class GetContestAllBroadcasterInfoRespDTO {
  public broadcasters: Record<string, GetContestAllBroadcasterInfoRespDTOItem>;
}

export class GetContestAllShotInfoReqDTO {
  @FromQuery()
  @IsString()
  @IsNotEmpty()
  public uca: string;
}

export class GetContestAllShotInfoRespDTOItem {
  public shotId: string;
  public shotName: string;
  public status: 'ready' | 'broadcasting';
  public tracks: {
    trackId: string;
    type: 'video' | 'audio';
  }[];
  public broadcastingTrackIds: string[];
}

export class GetContestAllShotInfoRespDTO {
  public shots: Record<string, GetContestAllShotInfoRespDTOItem>;
}
