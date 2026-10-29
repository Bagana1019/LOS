import { describe, expect, it } from 'vitest';
import { ChannelError, maskAddress } from '../../integrations/channel/channel-error';

describe('maskAddress', () => {
  it('утас: улсын код + сүүлийн 2 цифр', () => expect(maskAddress('SMS', '+97699112233')).toBe('+976******33'));
  it('имэйл: эхний тэмдэгт + домэйн', () => expect(maskAddress('EMAIL', 'bold@example.mn')).toBe('b***@example.mn'));
  it('push токен: эхний 4 ба сүүлийн 4', () => expect(maskAddress('PUSH', 'abcd1234efgh5678')).toBe('abcd***5678'));
  it('богино токен/утас бүрэн нуугдана', () => {
    expect(maskAddress('PUSH', 'abc')).toBe('***');
    expect(maskAddress('SMS', '123')).toBe('***');
    expect(maskAddress('EMAIL', 'nodomain')).toBe('***');
  });
  it('хоосон → null', () => { expect(maskAddress('SMS', null)).toBeNull(); expect(maskAddress('SMS', '')).toBeNull(); });
  it('masked утга нь бүтэн хаягийг агуулахгүй', () => {
    for (const [ch, a] of [['SMS', '+97699112233'], ['EMAIL', 'bold@example.mn'], ['PUSH', 'tokentokentoken1234']] as const) expect(maskAddress(ch, a)).not.toContain(a);
  });
});

describe('ChannelError', () => {
  it('код ба retryable хадгална, мессеж нь хаяг агуулахгүй', () => {
    const e = new ChannelError('RATE_LIMITED', true);
    expect(e).toMatchObject({ code: 'RATE_LIMITED', retryable: true, name: 'ChannelError' });
    expect(e.message).toMatch(/[А-Яа-я]/);
  });
});
