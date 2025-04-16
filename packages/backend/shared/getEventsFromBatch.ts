import { ethers } from "ethers";
import { UnifiedMinimalABI, ParsedEvent, getCategory, getGovBodyFromAddress } from "~/shared";

/**
 * Queries logs for multiple contracts and events over a block range.
 */
export const monitorEventsInRange = async (
  fromBlock: number,
  toBlock: number,
  provider: ethers.Provider,
  contractsConfig: { [address: string]: string[] },
  networkName: string, // Added networkName
  chainId: number      // Added chainId
): Promise<ParsedEvent[]> => {
  console.time(`monitor-range-${fromBlock}-${toBlock}`);
  const collectedEvents: ParsedEvent[] = [];
  try {
    // For each contract and its events, query the logs over the whole range
    for (const [address, events] of Object.entries(contractsConfig)) {
      console.log(`🔍 Checking contract ${address} for events: ${events.join(", ")}`);
      const contract = new ethers.Contract(address, UnifiedMinimalABI, provider);
      for (const eventName of events) {
        try {
          const logs = await contract.queryFilter(eventName, fromBlock, toBlock);
          
          // Store a cache of block timestamps to avoid repeated fetches
          const blockTimestamps: Record<number, number> = {};
          
          for (const log of logs) {
            const eventFragment = contract.interface.getEvent(eventName);
            if (!eventFragment) {
              throw new Error(`🚨 Failed to get event fragment for ${eventName} on ${address}`);
            }
            
            // Decode the log
            const decodedData = contract.interface.decodeEventLog(
              eventFragment,
              log.data,
              log.topics
            );
            
            const args: Record<string, unknown> = {};
            eventFragment.inputs.forEach((input, index) => {
              args[input.name] = decodedData[index];
            });
            
            // Fetch block timestamp if not already cached
            let timestamp: number;
            if (!blockTimestamps[log.blockNumber]) {
              try {
                const block = await provider.getBlock(log.blockNumber);
                if (block && block.timestamp) {
                  blockTimestamps[log.blockNumber] = Number(block.timestamp);
                } else {
                  console.warn(`⚠️ Block ${log.blockNumber} has no timestamp, using current time`);
                  blockTimestamps[log.blockNumber] = Math.floor(Date.now() / 1000);
                }
              } catch (error) {
                console.warn(`⚠️ Failed to get block ${log.blockNumber}, using current time:`, error);
                blockTimestamps[log.blockNumber] = Math.floor(Date.now() / 1000);
              }
            }
            
            timestamp = blockTimestamps[log.blockNumber];
            
            // Validate timestamp (ensure it's not in the future)
            const now = Math.floor(Date.now() / 1000);
            const isFutureTimestamp = timestamp > now;
            
            if (isFutureTimestamp) {
              console.warn(`⚠️ Block ${log.blockNumber} has a future timestamp: ${timestamp}, using current time instead`);
              timestamp = now;
            }
            
            // Organize the event as needed
            const blockExplorerBaseUrl = networkName === 'Ethereum Mainnet' ? 'https://etherscan.io' : 'https://explorer.zksync.io';
            const link = `${blockExplorerBaseUrl}/tx/${log.transactionHash}`;

            const proposalLink = args.proposalId
              ? `https://vote.zknation.io/dao/proposal/${args.proposalId}?govId=eip155:${chainId}:${address}`
              : "";

            collectedEvents.push({
              interface: eventFragment,
              rawData: log.data,
              decodedData,
              title: `${eventName} - ${getGovBodyFromAddress(address)}`,
              link,
              txhash: log.transactionHash,
              eventName,
              blocknumber: log.blockNumber,
              address,
              args,
              topics: [getCategory(address)],
              timestamp: String(timestamp), // Use actual block timestamp
              proposalLink,
              networkName, 
              chainId: String(chainId)
            });
          }
        } catch (err: unknown) {
          const errorMessage = `
            🚨 ERROR processing event ${eventName} on contract ${address} from block ${fromBlock} to ${toBlock}
            Error: ${err instanceof Error ? err.message : String(err)}
          `;
          console.error(errorMessage);
          throw new Error(errorMessage);
        }
      }
    }
    if (!collectedEvents.length) {
      console.log(`ℹ️ No events found between blocks ${fromBlock} and ${toBlock}`);
    } else {
      console.log(`✅ Successfully processed ${collectedEvents.length} events between blocks ${fromBlock} and ${toBlock}`);
    }
    return collectedEvents;
  } catch (err: unknown) {
    console.error(`🚨 FATAL ERROR processing blocks ${fromBlock}-${toBlock}: ${err instanceof Error ? err.message : String(err)}`, err instanceof Error ? err.stack : undefined);
    throw err;
  } finally {
    console.timeEnd(`monitor-range-${fromBlock}-${toBlock}`);
  }
};
