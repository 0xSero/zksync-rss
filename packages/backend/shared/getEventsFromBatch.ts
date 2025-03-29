import { ethers } from "ethers";
import { UnifiedMinimalABI, EventsMapping, ParsedEvent, getCategory, getGovBodyFromAddress } from "~/shared";

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
          logs.forEach(log => {
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
            // Organize the event as needed
            const blockExplorerBaseUrl = networkName === 'Ethereum Mainnet' ? 'https://etherscan.io' : 'https://explorer.zksync.io';
            const link = `${blockExplorerBaseUrl}/tx/${log.transactionHash}`;

            // TODO: Fetch actual block timestamp if possible, otherwise estimate or handle appropriately
            // For now, using a placeholder or potentially inaccurate estimation based on block number
            // const block = await provider.getBlock(log.blockNumber); // This would be slow in a loop
            // const blockTimestamp = block ? new Date(block.timestamp * 1000).toISOString() : new Date().toISOString(); // Fallback to current time
            const blockTimestamp = new Date().toISOString(); // Placeholder: Using current time as timestamp is not reliable from logs alone

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
              timestamp: blockTimestamp, // Using placeholder timestamp
              proposalLink,
              networkName, // Use passed-in networkName
              chainId: String(chainId) // Use passed-in chainId, converting to string
            });
          });
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
