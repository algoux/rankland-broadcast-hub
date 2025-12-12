import { Provide, Inject } from 'bwcx-core';
import { LiveContest, LiveContestModel } from '@server/models/live-contest.model';
import { LiveContestMemberModel, type LiveContestMember } from '@server/models/live-contest-member.model';
import LogicException from '@server/exceptions/logic.exception';
import { ErrCode } from '@common/enums/err-code.enum';
import MiscUtils from '@server/utils/misc.util';
import type { User } from '@algoux/standard-ranklist';

export type LiveContestMemberInput = Omit<LiveContestMember, 'contestId' | 'createdAt' | 'updatedAt'>;

@Provide()
export default class LiveContestService {
  public constructor(@Inject() private readonly miscUtils: MiscUtils) {}

  private contestIdCacheMap = new Map<string, string>();

  public async findContestIdByAlias(alias: string): Promise<string> {
    let contestId = this.contestIdCacheMap.get(alias);
    if (contestId) {
      return contestId;
    }
    const existed = await LiveContestModel.findOne({ alias });
    if (!existed) {
      throw new LogicException(ErrCode.LiveContestNotFound);
    }
    contestId = existed._id.toString();
    this.contestIdCacheMap.set(alias, contestId);
    return contestId;
  }

  public async findContestByAlias(alias: string): Promise<LiveContest | null> {
    const contestId = await this.findContestIdByAlias(alias);
    const contest = await LiveContestModel.findById(contestId);
    if (!contest) {
      return null;
    }
    delete contest._id;
    // @ts-ignore
    delete contest.createdAt;
    // @ts-ignore
    delete contest.updatedAt;
    return contest;
  }

  public filterMemberForPublic(member: LiveContestMember | any): User {
    const memberObj = member && typeof member.toObject === 'function' ? member.toObject() : member;
    const { _id, contestId, banned, broadcasterToken, index, createdAt, updatedAt, ...publicMember } = memberObj as any;
    return publicMember as User;
  }

  public async findContestMembers(
    alias: string,
    filters?: {
      userId?: string;
      name?: string;
      organization?: string;
      markerId?: string;
      official?: boolean;
      teamMemberName?: string;
      banned?: boolean;
    },
  ): Promise<LiveContestMember[]> {
    const contestId = await this.findContestIdByAlias(alias);

    const query: any = {
      contestId,
    };

    if (filters) {
      if (filters.userId !== undefined) {
        query.id = filters.userId;
      }

      if (filters.name !== undefined) {
        query.name = { $regex: filters.name, $options: 'i' };
      }

      if (filters.organization !== undefined) {
        query.organization = { $regex: filters.organization, $options: 'i' };
      }

      if (filters.markerId !== undefined) {
        query.markers = filters.markerId;
      }

      if (filters.official !== undefined) {
        if (filters.official) {
          // official === true means "not explicitly false"
          query.$or = [{ official: { $exists: false } }, { official: { $ne: false } }];
        } else {
          query.official = false;
        }
      }

      if (filters.teamMemberName !== undefined) {
        query['teamMembers.name'] = { $regex: filters.teamMemberName, $options: 'i' };
      }

      if (filters.banned !== undefined) {
        query.banned = filters.banned;
      }
    }

    const members = await LiveContestMemberModel.find(query).sort({ index: 1 });
    return members;
  }

  public async findContestMemberById(alias: string, userId: string): Promise<LiveContestMember | null> {
    const contestId = await this.findContestIdByAlias(alias);

    const member = await LiveContestMemberModel.findOne({
      contestId,
      id: userId,
    });

    if (!member) {
      return null;
    }

    return member;
  }

  public async upsertContestMembers(contestId: string, members: LiveContestMemberInput[]): Promise<void> {
    if (!members || members.length === 0) {
      return;
    }

    const operations = members.map((member, index) => ({
      updateOne: {
        filter: { contestId, id: member.id },
        update: {
          $set: {
            ...member,
            banned: member.banned === undefined ? false : member.banned,
            contestId,
            index,
          },
        },
        upsert: true,
      },
    }));

    await LiveContestMemberModel.bulkWrite(operations);
  }

  public async replaceContestMembers(contestId: string, members: LiveContestMemberInput[]): Promise<void> {
    const requestedMemberIds = new Set(members.map((m) => m.id));
    const existingMembers = await LiveContestMemberModel.find({ contestId });
    const existingMemberIds = new Set(existingMembers.map((m) => m.id));

    const idsToDelete = Array.from(existingMemberIds).filter((id) => !requestedMemberIds.has(id));
    if (idsToDelete.length > 0) {
      await LiveContestMemberModel.deleteMany({
        contestId,
        id: { $in: idsToDelete },
      });
    }

    if (members.length > 0) {
      const operations = members.map((member, index) => {
        return {
          updateOne: {
            filter: { contestId, id: member.id },
            update: {
              $set: {
                ...member,
                banned: member.banned === undefined ? false : member.banned,
                contestId,
                index,
              },
            },
            upsert: true,
          },
        };
      });

      await LiveContestMemberModel.bulkWrite(operations);
    }
  }
}
