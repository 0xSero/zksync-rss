import { ethers } from "ethers";
import { UnifiedMinimalABI, EventsMapping, ParsedEvent, getCategory, getGovBodyFromAddress } from "~/shared";

/**
 * Queries logs for multiple contracts and events over a block range.
 */
export const monitorEventsInRange = async (
  fromBlock: number,
  toBlock: number,
  provider: ethers.Provider,
  contractsConfig: { [address: string]: string[] }
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
            const ETHEREUM_ADDRESSES = [
              "0x8f7a9912416e8adc4d9c21fae1415d3318a11897" // Example: Protocol Upgrade Handler
            ];
            const isEthereum = ETHEREUM_ADDRESSES.includes(address.toLowerCase());
            const link = isEthereum
              ? `https://etherscan.io/tx/${log.transactionHash}`
              : `https://explorer.zksync.io/tx/${log.transactionHash}`;
            const networkName = isEthereum ? "Ethereum Mainnet" : "ZKSync Era";
            const chainId = isEthereum ? "1" : "324";
            const blockTimestamp = new Date(log.blockNumber * 1000).toISOString(); // adjust as needed if timestamp is available from elsewhere
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
              timestamp: blockTimestamp,
              proposalLink: args.proposalId
                ? `https://vote.zknation.io/dao/proposal/${args.proposalId}?govId=eip155:${
                    address.toLowerCase() in EventsMapping["Ethereum Mainnet"] ? "1" : "324"
                  }:${address}`
                : "",
              networkName,
              chainId
            });
          });
        } catch (innerErr: any) {
          const errorMessage = `
            🚨 ERROR processing event ${eventName} on contract ${address} from block ${fromBlock} to ${toBlock}
            Error: ${innerErr.message}
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
  } catch (err: any) {
    console.error(`🚨 FATAL ERROR processing blocks ${fromBlock}-${toBlock}: ${err.message}`, err.stack);
    throw err;
  } finally {
    console.timeEnd(`monitor-range-${fromBlock}-${toBlock}`);
  }
};
