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
import { describe, it, before } from 'mocha'
import { expect, assert } from 'chai'
import { spy } from 'sinon'
import http from 'http'
import { getSdk } from './'
import { generateKeyPair } from '../../src/utils/crypto'

describe('Node Chain', function () {
  let sdkAccount, sdk
  const { publicKey } = generateKeyPair()

  before(async function () {
    sdkAccount = await getSdk()
    sdk = await getSdk({ withoutAccount: true })
  })

  it('determines the height', async () => {
    expect(await sdk.height()).to.be.a('number')
  })

  it('combines height queries', async () => {
    spy(http, 'request')
    const heights = await Promise.all(new Array(5).fill().map(() => sdk.height()))
    expect(heights).to.eql(heights.map(() => heights[0]))
    assert(http.request.calledOnce)
    http.request.restore()
  })

  it('waits for specified heights', async () => {
    const target = await sdk.height() + 1
    await sdk.awaitHeight(target).should.eventually.be.at.least(target)
    return sdk.height().should.eventually.be.at.least(target)
  })

  it('Can verify transaction from broadcast error', async () => {
    const error = await sdkAccount.spend(0, publicKey, { fee: 100, verify: false }).catch(e => e)
    expect(await error.verifyTx()).to.have.lengthOf(1)
  })

  it('Get top block', async () => {
    const top = await sdk.topBlock()
    top.should.has.property('hash')
    top.should.has.property('height')
  })

  it('Get pending transaction', async () => {
    const mempool = await sdk.mempool()
    mempool.should.has.property('transactions')
  })

  it('Get current generation', async () => {
    const generation = await sdk.getCurrentGeneration()
    generation.should.has.property('keyBlock')
  })

  it('Get key block', async () => {
    const { keyBlock } = await sdk.getCurrentGeneration()
    const keyBlockByHash = await sdk.getKeyBlock(keyBlock.hash)
    const keyBlockByHeight = await sdk.getKeyBlock(keyBlock.height)
    const keyBlockError = await sdk.getKeyBlock(false).catch(e => true)
    keyBlockByHash.should.be.an('object')
    keyBlockByHeight.should.be.an('object')
    keyBlockError.should.be.equal(true)
  })

  it('Get generation', async () => {
    const { keyBlock } = await sdk.getCurrentGeneration()
    const genByHash = await sdk.getGeneration(keyBlock.hash)
    const genByHeight = await sdk.getGeneration(keyBlock.height)
    const genArgsError = await sdk.getGeneration(true).catch(e => true)
    genByHash.should.be.an('object')
    genByHeight.should.be.an('object')
    genArgsError.should.be.equal(true)
  })

  it('polls for transactions', async () => {
    const senderId = await sdkAccount.address()
    const tx = await sdkAccount.spendTx({
      amount: 1,
      senderId,
      recipientId: publicKey,
      payload: '',
      ttl: Number.MAX_SAFE_INTEGER
    })
    const signed = await sdkAccount.signTransaction(tx)
    const { txHash } = await sdkAccount.api.postTransaction({ tx: signed })

    await sdkAccount.poll(txHash).should.eventually.be.fulfilled
    return sdkAccount.poll('th_xxx', { blocks: 1 }).should.eventually.be.rejected
  })

  it('Wait for transaction confirmation', async () => {
    const txData = await sdkAccount.spend(1000, await sdkAccount.address(), { confirm: true })
    const isConfirmed = (await sdkAccount.height()) >= txData.blockHeight + 3

    isConfirmed.should.be.equal(true)

    const txData2 = await sdkAccount.spend(1000, await sdkAccount.address(), { confirm: 4 })
    const isConfirmed2 = (await sdkAccount.height()) >= txData2.blockHeight + 4
    isConfirmed2.should.be.equal(true)
  })
})
