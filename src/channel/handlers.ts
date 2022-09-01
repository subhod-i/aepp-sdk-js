/*
 * ISC License (ISC)
 * Copyright (c) 2018 aeternity developers
 *
 *  Permission to use, copy, modify, and/or distribute this software for any
 *  purpose with or without fee is hereby granted, provided that the above
 *  copyright notice and this permission notice appear in all copies.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 *  REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 *  AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 *  INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 *  LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 *  OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 *  PERFORMANCE OF THIS SOFTWARE.
 */
/* eslint-disable consistent-return */
/* eslint-disable default-case */
/* eslint-disable @typescript-eslint/no-use-before-define */
import { generateKeyPair } from '../utils/crypto';
import {
  ChannelState,
  changeStatus,
  changeState,
  call,
  notify,
  emit,
  disconnect,
  ChannelMessage,
  ChannelFsm,
  SignTx,
  ChannelStatus,
} from './internal';
import { unpackTx, buildTx } from '../tx/builder';
import { encode, Encoded, Encoding } from '../utils/encoder';
import {
  IllegalArgumentError,
  InsufficientBalanceError,
  ChannelConnectionError,
  UnexpectedChannelMessageError,
} from '../utils/errors';
import type Channel from './Base';
import { Tag } from '../tx/builder/constants';

export async function appendSignature(
  tx: Encoded.Transaction,
  signFn: SignTx,
): Promise<Encoded.Transaction | number | null> {
  const { signatures, encodedTx } = unpackTx(tx, Tag.SignedTx).tx;
  const result = await signFn(encode(encodedTx.rlpEncoded, Encoding.Transaction));
  if (typeof result === 'string') {
    const { tx: signedTx } = unpackTx(result, Tag.SignedTx);
    return buildTx({
      signatures: signatures.concat(signedTx.signatures),
      encodedTx: signedTx.encodedTx.rlpEncoded,
    }, Tag.SignedTx).tx;
  }
  return result;
}

export async function appendSignatureAndNotify(
  channel: Channel,
  method: string,
  tx: Encoded.Transaction,
  signFn: SignTx,
): Promise<boolean> {
  const signedTx = await appendSignature(tx, signFn);
  const isError = typeof signedTx !== 'string';
  notify(channel, method, isError ? { error: signedTx ?? 1 } : { signed_tx: signedTx });
  return isError;
}

export function handleUnexpectedMessage(
  _channel: Channel,
  message: ChannelMessage,
  state: ChannelState,
): ChannelFsm {
  state?.reject?.(Object.assign(
    new UnexpectedChannelMessageError(`Unexpected message received:\n\n${JSON.stringify(message)}`),
    { wsMessage: message },
  ));
  return { handler: channelOpen };
}

export function awaitingConnection(
  channel: Channel,
  message: ChannelMessage,
): ChannelFsm | undefined {
  if (message.method === 'channels.info') {
    const channelInfoStatus: string = message.params.data.event;

    let nextStatus: ChannelStatus | null = null;
    if (channelInfoStatus === 'channel_accept') nextStatus = 'accepted';
    if (channelInfoStatus === 'funding_created') nextStatus = 'halfSigned';
    if (nextStatus != null) {
      changeStatus(channel, nextStatus);
      return { handler: awaitingChannelCreateTx };
    }

    if (message.params.data.event === 'channel_reestablished') {
      return { handler: awaitingOpenConfirmation };
    }
    if (message.params.data.event === 'fsm_up') {
      channel._fsmId = message.params.data.fsm_id;
      return { handler: awaitingConnection };
    }
    return { handler: awaitingConnection };
  }
  if (message.method === 'channels.error') {
    emit(channel, 'error', new ChannelConnectionError(message?.payload?.message));
    return { handler: channelClosed };
  }
}

export async function awaitingReconnection(
  channel: Channel,
  message: ChannelMessage,
  state: ChannelState,
): Promise<ChannelFsm> {
  if (message.method === 'channels.info') {
    if (message.params.data.event === 'fsm_up') {
      channel._fsmId = message.params.data.fsm_id;
      changeState(channel, (await call(channel, 'channels.get.offchain_state', {})).signed_tx);
      return { handler: channelOpen };
    }
  }
  return handleUnexpectedMessage(channel, message, state);
}

export async function awaitingChannelCreateTx(
  channel: Channel,
  message: ChannelMessage,
): Promise<ChannelFsm | undefined> {
  const tag = channel._options.role === 'initiator' ? 'initiator_sign' : 'responder_sign';
  if (message.method === `channels.sign.${tag}`) {
    if (message.params.data.tx != null) {
      const signedTx = await channel._options.sign(tag, message.params.data.tx);
      notify(channel, `channels.${tag}`, { tx: signedTx });
      return { handler: awaitingOnChainTx };
    }
    await appendSignatureAndNotify(
      channel,
      `channels.${tag}`,
      message.params.data.signed_tx,
      async (tx) => channel._options.sign(tag, tx),
    );
    return { handler: awaitingOnChainTx };
  }
}

export function awaitingOnChainTx(
  channel: Channel,
  message: ChannelMessage,
): ChannelFsm | undefined {
  if (message.method === 'channels.on_chain_tx') {
    if (message.params.data.info === 'funding_signed' && channel._options.role === 'initiator') {
      return { handler: awaitingBlockInclusion };
    }
    if (message.params.data.info === 'funding_created' && channel._options.role === 'responder') {
      return { handler: awaitingBlockInclusion };
    }
  }
  if (
    message.method === 'channels.info'
    && message.params.data.event === 'funding_signed'
    && channel._options.role === 'initiator'
  ) {
    channel._channelId = message.params.channel_id;
    changeStatus(channel, 'signed');
    return { handler: awaitingOnChainTx };
  }
}

export function awaitingBlockInclusion(
  channel: Channel,
  message: ChannelMessage,
): ChannelFsm | undefined {
  if (message.method === 'channels.info') {
    const handlers: {
      [key: string]: (channel: Channel, message: ChannelMessage) => ChannelFsm | undefined;
    } = {
      funding_created: awaitingBlockInclusion,
      own_funding_locked: awaitingBlockInclusion,
      funding_locked: awaitingOpenConfirmation,
    };
    const handler = handlers[message.params.data.event as string];
    if (handler != null) {
      return { handler };
    }
  }
  if (message.method === 'channels.on_chain_tx') {
    emit(channel, 'onChainTx', message.params.data.tx, {
      info: message.params.data.info,
      type: message.params.data.type,
    });
    return { handler: awaitingBlockInclusion };
  }
}

export function awaitingOpenConfirmation(
  channel: Channel,
  message: ChannelMessage,
): ChannelFsm | undefined {
  if (message.method === 'channels.info' && message.params.data.event === 'open') {
    channel._channelId = message.params.channel_id;
    return { handler: awaitingInitialState };
  }
}

export function awaitingInitialState(
  channel: Channel,
  message: ChannelMessage,
): ChannelFsm | undefined {
  if (message.method === 'channels.update') {
    changeState(channel, message.params.data.state);
    return { handler: channelOpen };
  }
}

export async function channelOpen(
  channel: Channel,
  message: ChannelMessage,
  state: ChannelState,
): Promise<ChannelFsm | undefined> {
  switch (message.method) {
    case 'channels.info':
      switch (message.params.data.event) {
        case 'update':
        case 'withdraw_created':
        case 'deposit_created':
          return { handler: awaitingTxSignRequest };
        case 'own_withdraw_locked':
        case 'withdraw_locked':
        case 'own_deposit_locked':
        case 'deposit_locked':
        case 'peer_disconnected':
        case 'channel_reestablished':
        case 'open':
          // TODO: Better handling of peer_disconnected event.
          //
          //       We should enter intermediate state where offchain transactions
          //       are blocked until channel is reestablished.
          emit(channel, message.params.data.event);
          return { handler: channelOpen };
        case 'fsm_up':
          channel._fsmId = message.params.data.fsm_id;
          return { handler: channelOpen };
        case 'timeout':
        case 'close_mutual':
          return { handler: channelOpen };
        case 'closing':
          changeStatus(channel, 'closing');
          return { handler: channelOpen };
        case 'closed_confirmed':
          changeStatus(channel, 'closed');
          return { handler: channelClosed };
        case 'died':
          changeStatus(channel, 'died');
          return { handler: channelClosed };
        case 'shutdown':
          return { handler: channelOpen };
      }
      break;
    case 'channels.on_chain_tx':
      emit(channel, 'onChainTx', message.params.data.tx, {
        info: message.params.data.info,
        type: message.params.data.type,
      });
      return { handler: channelOpen };
    case 'channels.leave':
      // TODO: emit event
      return { handler: channelOpen };
    case 'channels.update':
      changeState(channel, message.params.data.state);
      return { handler: channelOpen };
    case 'channels.sign.shutdown_sign_ack':
      return awaitingTxSignRequest(channel, message, state);
  }
}
channelOpen.enter = (channel: Channel) => {
  changeStatus(channel, 'open');
};

export async function awaitingOffChainTx(
  channel: Channel,
  message: ChannelMessage,
  state: ChannelState,
): Promise<ChannelFsm> {
  if (message.method === 'channels.sign.update') {
    const { sign } = state;
    if (message.params.data.tx != null) {
      const signedTx = await sign(message.params.data.tx, { updates: message.params.data.updates });
      notify(channel, 'channels.update', { tx: signedTx });
      return { handler: awaitingOffChainUpdate, state };
    }
    const isError = await appendSignatureAndNotify(
      channel,
      'channels.update',
      message.params.data.signed_tx,
      async (tx) => sign(tx, { updates: message.params.data.updates }),
    );
    return { handler: isError ? awaitingOffChainTx : awaitingOffChainUpdate, state };
  }
  if (message.method === 'channels.error') {
    state.reject(new ChannelConnectionError(message.data.message));
    return { handler: channelOpen };
  }
  if (message.error != null) {
    const { data } = message.error ?? { data: [] };
    if (data.find((i) => i.code === 1001) != null) {
      state.reject(new InsufficientBalanceError('Insufficient balance'));
    } else if (data.find((i) => i.code === 1002) != null) {
      state.reject(new IllegalArgumentError('Amount cannot be negative'));
    } else {
      state.reject(new ChannelConnectionError(message.error.message));
    }
    return { handler: channelOpen };
  }
  if (message.method === 'channels.conflict') {
    state.resolve({
      accepted: false,
      errorCode: message.params.data.error_code,
      errorMessage: message.params.data.error_msg,
    });
    return { handler: channelOpen };
  }
  if (message.method === 'channels.info') {
    if (message.params.data.event === 'aborted_update') {
      state.resolve({ accepted: false });
      return { handler: channelOpen };
    }
  }
  return handleUnexpectedMessage(channel, message, state);
}

export function awaitingOffChainUpdate(
  channel: Channel,
  message: ChannelMessage,
  state: ChannelState,
): ChannelFsm | undefined {
  if (message.method === 'channels.update') {
    changeState(channel, message.params.data.state);
    state.resolve({ accepted: true, signedTx: message.params.data.state });
    return { handler: channelOpen };
  }
  if (message.method === 'channels.conflict') {
    state.resolve({
      accepted: false,
      errorCode: message.params.data.error_code,
      errorMessage: message.params.data.error_msg,
    });
    return { handler: channelOpen };
  }
  if (message.method === 'channels.info') {
    if (message.params.data.event === 'aborted_update') {
      state.resolve({ accepted: false });
      return { handler: channelOpen };
    }
  }
  if (message.error != null) {
    state.reject(new ChannelConnectionError(message.error.message));
    return { handler: channelOpen };
  }
  return handleUnexpectedMessage(channel, message, state);
}

export async function awaitingTxSignRequest(
  channel: Channel,
  message: ChannelMessage,
  state: ChannelState,
): Promise<ChannelFsm | undefined> {
  const [, tag] = message.method.match(/^channels\.sign\.([^.]+)$/) ?? [];
  if (tag != null) {
    if (message.params.data.tx != null) {
      const signedTx = await channel._options.sign(tag, message.params.data.tx, {
        updates: message.params.data.updates,
      });
      if (signedTx != null) {
        notify(channel, `channels.${tag}`, { tx: signedTx });
        return { handler: channelOpen };
      }
    } else {
      const isError = await appendSignatureAndNotify(
        channel,
        `channels.${tag}`,
        message.params.data.signed_tx,
        async (tx) => channel._options.sign(tag, tx, { updates: message.params.data.updates }),
      );
      return isError ? { handler: awaitingUpdateConflict, state } : { handler: channelOpen };
    }
    // soft-reject via competing update
    notify(channel, 'channels.update.new', {
      from: generateKeyPair().publicKey,
      to: generateKeyPair().publicKey,
      amount: 1,
    });
    return { handler: awaitingUpdateConflict, state };
  }
  return handleUnexpectedMessage(channel, message, state);
}

export function awaitingUpdateConflict(
  channel: Channel,
  message: ChannelMessage,
  state: ChannelState,
): ChannelFsm {
  if (message.error != null) {
    return { handler: awaitingUpdateConflict, state };
  }
  if (message.method === 'channels.conflict') {
    return { handler: channelOpen };
  }
  return handleUnexpectedMessage(channel, message, state);
}

export async function awaitingShutdownTx(
  channel: Channel,
  message: ChannelMessage,
  state: ChannelState,
): Promise<ChannelFsm | undefined> {
  if (message.method === 'channels.sign.shutdown_sign') {
    if (message.params.data.tx != null) {
      const signedTx = await state.sign(message.params.data.tx);
      notify(channel, 'channels.shutdown_sign', { tx: signedTx });
      return { handler: awaitingShutdownOnChainTx, state };
    }
    await appendSignatureAndNotify(
      channel,
      'channels.shutdown_sign',
      message.params.data.signed_tx,
      async (tx) => state.sign(tx),
    );
    return { handler: awaitingShutdownOnChainTx, state };
  }
  return handleUnexpectedMessage(channel, message, state);
}

export function awaitingShutdownOnChainTx(
  channel: Channel,
  message: ChannelMessage,
  state: ChannelState,
): ChannelFsm {
  if (message.method === 'channels.on_chain_tx') {
    // state.resolve(message.params.data.tx)
    return { handler: channelClosed, state };
  }
  return handleUnexpectedMessage(channel, message, state);
}

export function awaitingLeave(
  channel: Channel,
  message: ChannelMessage,
  state: ChannelState,
): ChannelFsm {
  if (message.method === 'channels.leave') {
    state.resolve({ channelId: message.params.channel_id, signedTx: message.params.data.state });
    disconnect(channel);
    return { handler: channelClosed };
  }
  if (message.method === 'channels.error') {
    state.reject(new ChannelConnectionError(message.data.message));
    return { handler: channelOpen };
  }
  return handleUnexpectedMessage(channel, message, state);
}

export async function awaitingWithdrawTx(
  channel: Channel,
  message: ChannelMessage,
  state: ChannelState,
): Promise<ChannelFsm | undefined> {
  if (message.method === 'channels.sign.withdraw_tx') {
    const { sign } = state;
    if (message.params.data.tx != null) {
      const signedTx = await sign(message.params.data.tx, { updates: message.params.data.updates });
      notify(channel, 'channels.withdraw_tx', { tx: signedTx });
      return { handler: awaitingWithdrawCompletion, state };
    }
    await appendSignatureAndNotify(
      channel,
      'channels.withdraw_tx',
      message.params.data.signed_tx,
      async (tx) => sign(tx, { updates: message.params.data.updates }),
    );
    return { handler: awaitingWithdrawCompletion, state };
  }
  return handleUnexpectedMessage(channel, message, state);
}

export function awaitingWithdrawCompletion(
  channel: Channel,
  message: ChannelMessage,
  state: ChannelState,
): ChannelFsm {
  if (message.method === 'channels.on_chain_tx') {
    state.onOnChainTx?.(message.params.data.tx);
    return { handler: awaitingWithdrawCompletion, state };
  }
  if (message.method === 'channels.info') {
    if (['own_withdraw_locked', 'withdraw_locked'].includes(message.params.data.event)) {
      const callbacks: {
        [key: string]: Function | undefined;
      } = {
        own_withdraw_locked: state.onOwnWithdrawLocked,
        withdraw_locked: state.onWithdrawLocked,
      };
      callbacks[message.params.data.event]?.();
      return { handler: awaitingWithdrawCompletion, state };
    }
  }
  if (message.method === 'channels.update') {
    changeState(channel, message.params.data.state);
    state.resolve({ accepted: true, signedTx: message.params.data.state });
    return { handler: channelOpen };
  }
  if (message.method === 'channels.conflict') {
    state.resolve({
      accepted: false,
      errorCode: message.params.data.error_code,
      errorMessage: message.params.data.error_msg,
    });
    return { handler: channelOpen };
  }
  if (message.method === 'channels.info') {
    if (message.params.data.event === 'aborted_update') {
      state.resolve({ accepted: false });
      return { handler: channelOpen };
    }
  }
  return handleUnexpectedMessage(channel, message, state);
}

export async function awaitingDepositTx(
  channel: Channel,
  message: ChannelMessage,
  state: ChannelState,
): Promise<ChannelFsm | undefined> {
  if (message.method === 'channels.sign.deposit_tx') {
    const { sign } = state;
    if (message.params.data.tx != null) {
      const signedTx = await sign(
        message.params.data.tx,
        { updates: message.params.data.updates },
      );
      notify(channel, 'channels.deposit_tx', { tx: signedTx });
      return { handler: awaitingDepositCompletion, state };
    }
    await appendSignatureAndNotify(
      channel,
      'channels.deposit_tx',
      message.params.data.signed_tx,
      async (tx) => sign(tx, { updates: message.params.data.updates }),
    );
    return { handler: awaitingDepositCompletion, state };
  }
  return handleUnexpectedMessage(channel, message, state);
}

export function awaitingDepositCompletion(
  channel: Channel,
  message: ChannelMessage,
  state: ChannelState,
): ChannelFsm {
  if (message.method === 'channels.on_chain_tx') {
    state.onOnChainTx?.(message.params.data.tx);
    return { handler: awaitingDepositCompletion, state };
  }
  if (message.method === 'channels.info') {
    if (['own_deposit_locked', 'deposit_locked'].includes(message.params.data.event)) {
      const callbacks: {
        [key: string]: Function | undefined;
      } = {
        own_deposit_locked: state.onOwnDepositLocked,
        deposit_locked: state.onDepositLocked,
      };
      callbacks[message.params.data.event]?.();
      return { handler: awaitingDepositCompletion, state };
    }
  }
  if (message.method === 'channels.update') {
    changeState(channel, message.params.data.state);
    state.resolve({ accepted: true, signedTx: message.params.data.state });
    return { handler: channelOpen };
  }
  if (message.method === 'channels.conflict') {
    state.resolve({
      accepted: false,
      errorCode: message.params.data.error_code,
      errorMessage: message.params.data.error_msg,
    });
    return { handler: channelOpen };
  }
  if (message.method === 'channels.info') {
    if (message.params.data.event === 'aborted_update') {
      state.resolve({ accepted: false });
      return { handler: channelOpen };
    }
  }
  return handleUnexpectedMessage(channel, message, state);
}

export function channelClosed(
  _channel: Channel,
  message: ChannelMessage,
  state: ChannelState,
): ChannelFsm {
  if (state == null) return { handler: channelClosed };
  if (message.params.data.event === 'closing') return { handler: channelClosed, state };
  if (message.params.data.info === 'channel_closed') {
    state.closeTx = message.params.data.tx;
    return { handler: channelClosed, state };
  }
  if (message.params.data.event === 'closed_confirmed') {
    state.resolve(state.closeTx);
    return { handler: channelClosed };
  }
  return { handler: channelClosed, state };
}
