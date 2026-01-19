import { Contract, Data, Get, InjectCtx, RequestContext, UseGuards } from 'bwcx-ljsm';
import { Inject } from 'bwcx-core';
import { ApiController } from '@server/decorators';
import AuthGuard from '@server/guards/auth.guard';
import {
  GetContestAllBroadcasterInfoReqDTO,
  GetContestAllBroadcasterInfoRespDTO,
} from '@common/modules/live-contest/live-contest.dto';
import LiveContestService from './live-contest.service';

@ApiController()
export default class LiveContestController {
  public constructor(
    @InjectCtx()
    private readonly ctx: RequestContext,

    @Inject()
    private readonly service: LiveContestService,
  ) {}

  @Get()
  @UseGuards(AuthGuard)
  @Contract(GetContestAllBroadcasterInfoReqDTO, GetContestAllBroadcasterInfoRespDTO)
  public async getContestAllBroadcasterInfo(
    @Data() data: GetContestAllBroadcasterInfoReqDTO,
  ): Promise<GetContestAllBroadcasterInfoRespDTO> {
    const res = await this.service.getAllBroadcasterStoreInfo(data.uca);
    return {
      broadcasters: res,
    };
  }
}
