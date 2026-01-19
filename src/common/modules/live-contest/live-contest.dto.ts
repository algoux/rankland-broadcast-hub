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
