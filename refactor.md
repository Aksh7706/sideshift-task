# SideShift Task  

## Changes
The following modifications have been made to remove code inefficiencies:

1. The accountTxListResultSchema has been updated to contain more relevant data required for further transaction processing. The modified schema is as follows:

   ```typescript
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


2. Modifications have been made to the function `runScanByOrderId`. This function originally contained api calls to retrieve transaction details directly from  the node and subsequently fetched the block for timestamps, but these calls are unnecessary. We're already obtaining transaction details from the Etherscan API, which includes all necessary information, such as timestamps, making further network calls redundant.
   
   Hence, the following code in the function `runScanByOrderId` have been commented out to improve efficiency and the function is updated accordingly to use timestamp data coming from    Etherscan API

   ```typescript
   const ethersTx = await nodeProvider.getTransaction(etherscanTx.hash);

   if (!ethersTx) {
      logger.error('Transaction %s not found', etherscanTx.hash);

      return;
   }

   if (!ethersTx.blockNumber) {
      logger.warn('Transaction %s has no block number', etherscanTx.hash);

      return;
   }

   const block = await nodeProvider.getBlock(ethersTx.blockNumber);

   const timestamp = new Date(block.timestamp * 1000);
   ```
   Furthermore, considering the limited context provided during this task and after confirming the logical correctness of the code through email correspondence, the original logic for fetching all Etherscan transactions, within the API limit, for a deposit address in a single api call and then filtering the top 10 transactions with values greater than zero has been preserved.

   However, there is potential for further enhancements based on the transaction volume that deposit addresses go through. These improvements are detailed in the [Future Improvements](#future-improvements) section.

3. Function `getEtherScanTxListForAddress` has been modified to parse the axios response correctly. Also, error handling has been implemented to address potential Etherscan API errors effectively. Here's the updated version of the function:

   ```typescript
   /**
   * @param address 
   * @returns Promise resolving to an array of Etherscan transactions
   */
   const getEtherScanTxListForAddress = async (address: string): Promise<EtherscanTransaction[]> => {
      const { data } = await axios.get(
         `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&sort=desc&apikey=${etherscanApiKey}`
      )

      if (data.status === '0' && data.result.length > 0) throw Error(`Received error ${data.result} from Etherscan API`)
      return accountTxListResultSchema.parse(data.result)
   };
   ```
4. Function  `scanTxId` has been modified to utilize transaction values coming from Etherscan API and to remove checks which are now unnecessary. Additionally, `scanTxId` been modified to remove redundant fetchOrderForAddress api call, as order details have already been fetched earlier. Here's the updated code for `scanTxId`:
   
   ```typescript
   /**
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
   ```

## Future Improvements

1. Currently, we are not implementing pagination for the results obtained from the Etherscan API. This approach is acceptable for our current transaction volume, as the expected number of transactions to be fetched is not very large. However, for larger transaction volumes, implementing pagination becomes a more efficient approach. Moreover, in scenarios of high transaction volumes, it is more efficient to directly fetch transactions that occurred after the order was placed, and pagination can be considered based on the expected transaction counts to achieve the desired results. Here's a sample code for how it can be done:

   ```typescript
   const BASE_URL = "https://api.etherscan.io/api";
   const PAGE_SIZE = 50;
   const constructEtherscanURL = (params: any) => `${BASE_URL}?${new URLSearchParams({ ...params, apikey: etherscanApiKey })}`;

   const getEtherScanTxListForAddress = async (address: string, startBlock: number = 0, page: number = 1, offset: number = PAGE_SIZE) => {
      const url = constructEtherscanURL({ module: "account", action: "txlist", address: address, sort: "desc", startblock: startBlock, offset: offset, page: page })
      const { data } = await axios.get(url)
      if (data.status === '0' && data.result.length !== 0) throw Error(`Received error ${data.result} from Etherscan API`)
      return accountTxListResultSchema.parse(data.result)
   };

   const getNearestBlockNumber = async (timestamp: number) => {
      const url = constructEtherscanURL({ module: "block", action: "getblocknobytime", timestamp: timestamp, closest: "after" })
      const { data } = await axios.get(url)
      if (data.status === '0' && data.result.length !== 0) throw Error(`Received error ${data.result} from Etherscan API`)
      return Number(data.result)
   }

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
            const timestampInSeconds = Math.floor(order.createdAt.getTime() / 1000);
            const startBlock = await getNearestBlockNumber(timestampInSeconds);
            txs = await getEtherScanTxListForAddress(order.depositAddress.address, startBlock);
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
            logger.info('Scanning tx %s', etherscanTx.hash);
            await scanTxId(etherscanTx, orderId);
         });
      });
    };
   ```
2. It is recommended to use `gasUsed` instead of `gasLimit` when calculating the total ether amount in the `scanTxid` function. Since it has been confirmed through email correspondence that the original code is logically correct, therefore I didn't make this change in the updated code.

   Original code:
   ```typescript
   const total = ns.sum(
      tx.value.toString(),
      ns.times(tx.gasLimit.toString(), tx.gasPrice.toString())
   );
   ```
   
   Updated code that uses Etherscan transaction details where tx.gas represents the gasLimit:
   ```typescript
   const total = ns.sum(tx.value, ns.times(tx.gas, tx.gasPrice));
    ```

    An improved version:
    ```typescript
    const total = ns.sum(tx.value, ns.times(tx.gasUsed, tx.gasPrice));
    ```


