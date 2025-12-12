import { Exception } from 'bwcx-ljsm';
import type { ErrCode } from '@common/enums/err-code.enum';
import { errCodeConfigs } from '@server/err-code-configs';

export default class LogicException extends Exception {
  public code: ErrCode;

  public constructor(code: ErrCode) {
    super(`Logic error ${code}: ${errCodeConfigs[code] || 'Unknown error'}`);
    this.name = 'LogicException';
    this.code = code;
  }
}
