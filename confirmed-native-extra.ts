import { strict as assert } from 'assert';
import * as ethers from 'ethers';
import pMap from 'p-map';
import { z } from 'zod';
import axios from 'axios';
// `ns` is our own wrapper for bignumber.js to deal with mathematic operations for strings
import { ns } from '@sideshift/shared';
// `Order` is a TypeORM Entity, i.e a database table
// `memGetInternalGqlc` returns a GraphQL client memoized by lodash.memoize function
// `RedisTaskQueue` is a messaging queue that utilizes Redis to store messages
import { Order, createLogger, memGetInternalGqlc, RedisTaskQueue } from '@sideshift/shared-node';
// returns a unique ID to identify deposits
import { getEthereumNativeDepositUniqueId } from './shared';
// `context` stores application data, it uses `p-lazy` for efficiency
import { contextLazy } from './context';

const accountTxListResultSchema = z.array(
  z.object({
    hash: z.string(),
    from: z.string(),
    to: z.string(),
    value: z.string(),
    timeStamp: z.string(),
    gasPrice: z.string(),
    gas: z.string(),
    gasUsed: z.string(),
  })
);

/**
 * Checks specific deposit addresses for missed deposits
 */
export const runConfirmedNativeTokenExtraWorker = async (): Promise<void> => {
  const context = await contextLazy;
  const {
    config,
    db,
    nativeMethod,
    network,
    nodeProvider,
    config: { etherscanApiKey, evmAccount: account },
  } = context;

  const { asset } = nativeMethod;

  const logger = createLogger('ethereum:deposit:confirmed-native');
  const graphQLClient = memGetInternalGqlc();

  type EtherscanTransaction = z.infer<typeof accountTxListResultSchema>[number]

  /**
   * This function processes a transaction and, if it represents a successful deposit, logs the transaction.
   * 
   * Modifications have been made to this function to remove redundant fetchOrderForAddress api call 
   * and to remove unnecessary checks.
   * 
   * @param tx The Etherscan transaction to be processed.
   * @param orderId The associated order id.
   * @returns {boolean} indicating whether the transaction was successfully logged as a deposit.
  */
  const scanTxId = async (tx: EtherscanTransaction, orderId: string) => {
    // Removing unnecessary checks
    // assert.equal(typeof tx, 'object', 'tx is not object');
    // assert(tx.from, 'from missing');

    // const { hash: txid, blockHash } = tx;

    // if (typeof txid !== 'string') {
    //   throw new Error(`txid must be string`);
    // }

    // if (typeof blockHash !== 'string') {
    //   throw new Error(`blockHash must be string`);
    // }

    if (!tx.to) {
      // Contract creation
      return false;
    }

    if (tx.to.toLowerCase() !== account.toLowerCase()) {
      // Not the result of a sweep
      return false;
    }

    // Removing redundant checks. Already performed this before.
    // if (!+tx.value) {
    //   return false;
    // }

    if (!tx.gasPrice) {
      throw new Error('Unsupported EIP-1559 sweep transaction');
    }

    const total = ns.sum(tx.value, ns.times(tx.gas, tx.gasPrice));

    // Eliminating redundant network calls. Order details have already been fetched previously.
    // const order = await fetchOrderForAddress(tx.from);

    // if (!order) {
    //   return false;
    // }

    const valueAsEther = ethers.utils.formatEther(tx.value);
    const totalAsEther = ethers.utils.formatEther(total);

    const wasCredited = await graphQLClient.maybeInternalCreateDeposit({
      orderId: orderId,
      tx: {
        txid: tx.hash,
      },
      amount: totalAsEther,
      uniqueId: getEthereumNativeDepositUniqueId(nativeMethod, tx.hash),
    });

    if (!wasCredited) {
      return false;
    }

    logger.info(`Stored deposit. ${tx.hash}. ${valueAsEther} ${asset} for order ${orderId}`);
    return true;
  };

  /**
   * This function gets transactions for a given address from the Etherscan API.
   * 
   * Modifications have been made to this function. 
   * The axios response is now correctly parsed, ensuring proper handling of the API data.
   * Error handling has also been implemented to address potential Etherscan API errors effectively.
   * 
   * @param address 
   * @returns Promise resolving to an array of Etherscan transactions
   */
  const getEtherScanTxListForAddress = async (address: string): Promise<EtherscanTransaction[]> => {
    const { data } = await axios
      .get(
        `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&sort=desc&apikey=${etherscanApiKey}`
      )

    if (data.status === '0' && data.result.length > 0) throw Error(`Received error ${data.result} from Etherscan API`)
    return accountTxListResultSchema.parse(data.result)
  };

  /** 
  * This function originally contained api calls to retrieve transaction details directly from 
  * the node and subsequently fetched the block for timestamps, but these calls are unnecessary. 
  * We're already obtaining transaction details from the Etherscan API, which includes
  * all necessary information, such as timestamps, making further network calls redundant.
  * 
  * By eliminating these redundant API calls, we can significantly improve efficiency.
  * Hence, code relating to redundant api calls have been commented out.
  */
  const runScanByOrderId = async () => {
    const queue = await RedisTaskQueue.queues.evmNativeConfirm(network, true);

    if (!etherscanApiKey) {
      logger.error('Etherscan not configured');
      return;
    }

    await queue.run(async (orderId: string) => {
      logger.info('Processing queued task to look at order %s for deposits', orderId);

      const order = await db.getRepository(Order).findOneBy({ id: orderId });

      if (!order) {
        logger.error('Order %s not found', orderId);
        return;
      }

      if (!order.depositAddress) {
        // The deposit address may have been unassigned
        logger.error('Order %s has no deposit address', orderId);
        return;
      }

      let txs;

      try {
        // In descending order
        txs = await getEtherScanTxListForAddress(order.depositAddress.address);
      } catch (error: any) {
        logger.error(error, 'Error fetching txs for order %s: %s', orderId, error.message);
        return;
      }

      // Only transactions with a value
      txs = txs.filter(tx => ethers.BigNumber.from(tx.value).gt(0));

      // Only the first 10 transactions
      txs = txs.slice(0, 10);

      logger.info('Found %s transactions for order %s', txs.length, orderId);

      await pMap(txs, async (etherscanTx: EtherscanTransaction) => {
        // const ethersTx = await nodeProvider.getTransaction(etherscanTx.hash);

        // if (!ethersTx) {
        //   logger.error('Transaction %s not found', etherscanTx.hash);

        //   return;
        // }

        // if (!ethersTx.blockNumber) {
        //   logger.warn('Transaction %s has no block number', etherscanTx.hash);

        //   return;
        // }

        // const block = await nodeProvider.getBlock(ethersTx.blockNumber);

        // const timestamp = new Date(block.timestamp * 1000);


        // To convert to milliseconds
        const timestamp = Number(etherscanTx.timeStamp) * 1000;

        // Only transactions that happened after the order was created
        // This should handle deposit address re-assignment
        if (timestamp < order.createdAt.getTime()) {
          logger.warn('Ignoring tx %s that happened before order %s was created', etherscanTx.hash, orderId);
          return;
        }

        logger.info('Scanning tx %s', etherscanTx.hash);
        
        await scanTxId(etherscanTx, orderId);
      });
    });
  };

  await runScanByOrderId();
};
