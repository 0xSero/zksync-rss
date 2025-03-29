import { ethers } from "ethers";
import { UnifiedMinimalABI, EventsMapping, ParsedEvent, getCategory, getGovBodyFromAddress } from "~/shared";

export const monitorEventsAtBlock = async (
  blocknumber: number,
  provider: ethers.Provider,
  contractsConfig: { [address: string]: string[] }
): Promise<ParsedEvent[]> => {
  try {
    const block = await provider.getBlock(blocknumber);
    if (!block) {
      throw new Error(`Block ${blocknumber} not found`);
    }
    if (!block.timestamp) {
      throw new Error(`Block ${blocknumber} has no timestamp`);
    }

    const allEventPromises = Object.entries(contractsConfig).flatMap(([address, events]) => {
      const contract = new ethers.Contract(address, UnifiedMinimalABI, provider);

      const eventLogsPromises = events.map(eventName =>
        contract.queryFilter(eventName, blocknumber, blocknumber)
          .then(eventLogs => {
            return eventLogs.map(log => {
              const eventFragment = contract.interface.getEvent(eventName);
              if (!eventFragment) {
                throw new Error(`Failed to get event fragment for ${eventName} on ${address}`);
              }

              try {
                const decodedData = contract.interface.decodeEventLog(
                  eventFragment,
                  log.data,
                  log.topics
                );

                const args: Record<string, unknown> = {};
                eventFragment.inputs.forEach((input, index) => {
                  args[input.name] = decodedData[index];
                });

                return {
                  eventName,
                  txhash: log.transactionHash,
                  blocknumber: log.blockNumber,
                  address: log.address,
                  topics: log.topics,
                  interface: eventFragment,
                  args,
                  rawData: log.data,
                  decodedData
                };
              } catch (decodeError) {
                throw new Error(`Failed to decode event ${eventName} on ${address}: ${(decodeError as unknown as Error).message}`);
              }
            });
          })
          .catch((err) => {
            const errorMessage = `Error processing event at block ${blocknumber}, contract ${address}, event ${eventName}: ${err.message}`;
            throw new Error(errorMessage);
          })
      );
      return eventLogsPromises;
    });

    const results = await Promise.all(allEventPromises);

    const organizedEvents = results.flatMap((result) => {
      if (!result) {
        throw new Error(`Received null result when processing events at block ${blocknumber}`);
      }

      return result.filter(e => e != undefined).map(event => {
        if (!event?.interface) {
          throw new Error(`Invalid event data at block ${blocknumber}`);
        }
        const ETHEREUM_ADDRESSES = [
          '0x8f7a9912416e8adc4d9c21fae1415d3318a11897'  // Protocol Upgrade Handler
        ];
        const isEthereum = ETHEREUM_ADDRESSES.includes(event.address.toLowerCase());
        const link = isEthereum ?
          `https://etherscan.io/tx/${event.txhash}` :
          `https://explorer.zksync.io/tx/${event.txhash}`;
        const networkName = isEthereum ? 'Ethereum Mainnet' : 'ZKSync Era';
        const chainId = isEthereum ? '1' : '324';
        return {
          interface: event.interface,
          rawData: event.rawData,
          decodedData: event.decodedData,
          title: `${event.eventName} - ${getGovBodyFromAddress(event.address)}`,
          link,
          txhash: event.txhash,
          eventName: event.eventName,
          blocknumber: event.blocknumber,
          address: event.address,
          args: event.args,
          topics: [getCategory(event.address)],
          timestamp: String(block.timestamp),
          proposalLink: event.args.proposalId ?
            `https://vote.zknation.io/dao/proposal/${event.args.proposalId}?govId=eip155:${
              event.address.toLowerCase() in EventsMapping["Ethereum Mainnet"] ? '1' : '324'
            }:${event.address}` : '',
          networkName,
          chainId,
        };
      });
    });

    return organizedEvents;
  } catch (err: unknown) {
    const errorMessage = `Error processing block ${blocknumber}: ${(err as Error).message}`;
    throw new Error(errorMessage);
  }
};
