#!/usr/bin/env node
/*
 * ISC License (ISC)
 * Copyright (c) 2021 aeternity developers
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

// # Transfer AE
//
// ## Introduction
// The whole script is [located in the repository](https://github.com/aeternity/aepp-sdk-js/blob/master/examples/node/transfer-ae.mjs)
// and this page explains in detail how to:
//
//  - initialize an instance of the SDK with a pre-funded account
//  - transfer AE to another account

// ## 1. Specify imports
// You need to import `AeSdk`, `Node` and `MemoryAccount` classes from the SDK.
import { AeSdk, Node, MemoryAccount } from '@aeternity/aepp-sdk';

// **Note**:
//
//  - You need to have the SDK installed via `npm i @aetenity/aepp-sdk -g` to run that example code.

// ## 2. Define constants
// The following constants are used in the subsequent code snippets.
const ACCOUNT_KEYPAIR = {
  publicKey: 'ak_2dATVcZ9KJU5a8hdsVtTv21pYiGWiPbmVcU1Pz72FFqpk9pSRR',
  secretKey: 'bf66e1c256931870908a649572ed0257876bb84e3cdf71efb12f56c7335fad54d5cf08400e988222f26eb4b02c8f89077457467211a6e6d955edb70749c6a33b',
};
const NODE_URL = 'https://testnet.aeternity.io';
const [amount = 1, recipient = ACCOUNT_KEYPAIR.publicKey] = process.argv.slice(2);

// Note:
//
//  - The secret key of the account is pre-funded and only used for demonstration purpose
//      - You should replace it with your own keypair
//        (see [Create a Keypair](../../quick-start.md#2-create-a-keypair))
//  - In case the account runs out of funds you can always request AE using the [Faucet](https://faucet.aepps.com/)
//  - By default the script will transfer `1 aetto` and use the demo account itself as recipient
//      - Optionally you can provide the amount and a different recipient by providing the
//        arguments when executing the script,
//        e.g. `node transfer-ae.js 3 ak_6D2uyunJaERXfgbsc94G8vrp79nZrbtorL7VCRXk3sWiFK5jb`

// ## 3. Create object instances
const account = new MemoryAccount(ACCOUNT_KEYPAIR.secretKey);
const node = new Node(NODE_URL);
const aeSdk = new AeSdk({
  nodes: [{ name: 'testnet', instance: node }],
  accounts: [account],
});

// ## 4. Get AE balance of recipient (before transfer)
// Before the transfer of AE you can check the AE balance of the recipient.
const balanceBefore = await aeSdk.getBalance(recipient);
console.log(`Balance of ${recipient} (before): ${balanceBefore} aettos`);

// ## 5. Transfer AE
// Calling the `spend` function will create, sign and broadcast a `SpendTx` to the network.
const tx = await aeSdk.spend(amount, recipient);
console.log('Transaction mined', tx);

// ## 6. Get AE balance of recipient (after transfer)
const balanceAfter = await aeSdk.getBalance(recipient);
console.log(`Balance of ${recipient} (after): ${balanceAfter} aettos`);

// Note:
//
//  - If the recipient is the same account as the sender (default of the script if no arguments
//    provided) the balance will be lower after transfer because a transaction `fee` has been
//    paid to the miners.

// ## 7. Transfer a fraction of your AE to another account
// Instead of `spend` function you can use the `transferFunds` function
// to transfer a fraction of your AE to another account
const fraction = 1;
// `fraction` * 100 = % of AE to be transfered (e.g. 0.5 for 50% or 1 for 100%)
const transferTx = await aeSdk.transferFunds(fraction, recipient);
console.log('Transaction mined', transferTx);
