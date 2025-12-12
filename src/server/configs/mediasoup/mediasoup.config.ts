import { Config } from 'bwcx-ljsm';
import type { RtpCodecCapability } from 'mediasoup/node/lib/RtpParameters';

@Config()
export default class MediasoupConfig {
  public readonly rtcMinPort: number = 40000;
  public readonly rtcMaxPort: number = 49999;

  // @see https://github.com/versatica/mediasoup/blob/v3/node/src/supportedRtpCapabilities.ts
  public readonly mediaCodecs: RtpCodecCapability[] = [
    {
			kind: 'audio',
			mimeType: 'audio/opus',
			clockRate: 48000,
			channels: 2,
			rtcpFeedback: [{ type: 'nack' }, { type: 'transport-cc' }],
		},
    {
			kind: 'video',
			mimeType: 'video/VP8',
			clockRate: 90000,
			rtcpFeedback: [
				{ type: 'nack' },
				{ type: 'nack', parameter: 'pli' },
				{ type: 'ccm', parameter: 'fir' },
				{ type: 'goog-remb' },
				{ type: 'transport-cc' },
			],
		},
		{
			kind: 'video',
			mimeType: 'video/VP9',
			clockRate: 90000,
			rtcpFeedback: [
				{ type: 'nack' },
				{ type: 'nack', parameter: 'pli' },
				{ type: 'ccm', parameter: 'fir' },
				{ type: 'goog-remb' },
				{ type: 'transport-cc' },
			],
		},
		{
			kind: 'video',
			mimeType: 'video/H264',
			clockRate: 90000,
			parameters: {
				'level-asymmetry-allowed': 1,
			},
			rtcpFeedback: [
				{ type: 'nack' },
				{ type: 'nack', parameter: 'pli' },
				{ type: 'ccm', parameter: 'fir' },
				{ type: 'goog-remb' },
				{ type: 'transport-cc' },
			],
		},
  ];
}
