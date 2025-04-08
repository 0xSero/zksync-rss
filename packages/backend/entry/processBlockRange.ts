import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { addEventToRSS, updateRSSFeed } from "~/rss/utils";
import {
  convertBigIntToString,
  EventsMapping,
  NetworkConfig,
  downloadFromGCS,
  uploadToGCS,
  GCS_BUCKET_NAME,
  GCS_STATE_FILE_PATH,
  GCS_HISTORY_FILE_PATH,
  ProcessingHistory,
  ProcessingRecord
} from "~/shared";
import dotenv from "dotenv";
import { monitorEventsInRange } from "~/shared/getEventsFromBatch"; // New batched events function

interface ProcessingState {
  lastProcessedBlock: number;
  hasError: boolean;
  lastError?: string;
  lastUpdated: string;
}

// Configuration
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const STATE_FILE_PATH = path.join(__dirname, "../data/processing-state.json");
const BATCH_SIZE = 100;
const BATCH_DELAY = 1000;
const LOCK_FILE_PATH = path.join(__dirname, "../data/processing-history.lock");
const ARCHIVE_THRESHOLD = 1000;
const MIN_TIME_BETWEEN_ARCHIVES = 10 * 60 * 1000; // 10 minutes

async function downloadStateFile() {
  try {
    const dir = path.dirname(STATE_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await downloadFromGCS(GCS_BUCKET_NAME, GCS_STATE_FILE_PATH, STATE_FILE_PATH);
    console.log("State file downloaded successfully");
  } catch (error) {
    console.warn("Failed to download state file from GCS, starting fresh:", error);
  }
}

async function uploadStateFile() {
  try {
    if (!fs.existsSync(STATE_FILE_PATH)) {
      console.error("State file does not exist for upload");
      return;
    }
    const content = fs.readFileSync(STATE_FILE_PATH, "utf-8");
    await uploadToGCS(GCS_BUCKET_NAME, STATE_FILE_PATH, GCS_STATE_FILE_PATH, content);
    console.log("State file uploaded successfully");
    fs.unlinkSync(STATE_FILE_PATH);
    console.log("Local state file cleaned up");
  } catch (error) {
    console.error("Failed to upload state file to GCS:", error);
  }
}

async function acquireLock(timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function tryLock() {
      fs.writeFile(LOCK_FILE_PATH, process.pid.toString(), { flag: "wx" }, (err) => {
        if (!err) return resolve();
        if (Date.now() - start > timeout) return reject(new Error("Could not acquire lock"));
        setTimeout(tryLock, 100);
      });
    }
    tryLock();
  });
}

async function releaseLock(): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.unlink(LOCK_FILE_PATH, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

/**
 * Processes a range of blocks in batches using the new batched log query.
 */
async function processBlockRangeForNetwork(
  config: NetworkConfig,
  startBlock: number,
  endBlock: number,
  batchSize: number = BATCH_SIZE
) {
  console.log(`Processing ${config.networkName} blocks ${startBlock} to ${endBlock}`);
  const record: ProcessingRecord = {
    network: config.networkName,
    startBlock,
    endBlock,
    timestamp: new Date().toISOString(),
    errors: [],
    eventsFound: 0
  };

  let foundEvents = false;
  // Process blocks in batches rather than one-by-one
  for (let batchStart = startBlock; batchStart <= endBlock; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize - 1, endBlock);
    console.log(`Processing ${config.networkName} batch: ${batchStart} to ${batchEnd}`);

    try {
      // Use the new batched query function
      const events = await monitorEventsInRange(batchStart, batchEnd, config.provider, config.eventsMapping, config.networkName, config.chainId);
      if (events.length > 0) {
        foundEvents = true;
        record.eventsFound += events.length;
        events.forEach((event) => {
          addEventToRSS(
            event.address,
            event.eventName,
            event.topics,
            event.title,
            event.link,
            config.networkName,
            config.chainId,
            event.blocknumber,
            config.governanceName,
            event.proposalLink,
            event.timestamp,
            convertBigIntToString(event.args)
          );
        });
      }
      // Update state after finishing the batch
      updateState(config.networkName, {
        lastProcessedBlock: batchEnd,
        hasError: false,
        lastError: undefined
      });
      batchStart = batchEnd;
    } catch (error) {
      console.error(`Error processing ${config.networkName} blocks ${batchStart} to ${batchEnd}:`, error);
      record.errors.push({
        block: batchStart,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
      updateState(config.networkName, {
        lastProcessedBlock: batchStart - 1,
        hasError: true,
        lastError: error instanceof Error ? error.message : String(error)
      });
    }

    // Delay between batches if needed
    if (batchEnd < endBlock) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY));
    }
  }

  await updateProcessingHistory(record);
  return foundEvents;
}

function updateState(network: string, state: Partial<ProcessingState>) {
  const dir = path.dirname(STATE_FILE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  let allStates: Record<string, ProcessingState> = {};
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      allStates = JSON.parse(fs.readFileSync(STATE_FILE_PATH, "utf8"));
    }
  } catch (error) {
    console.warn("Error reading state file, starting fresh:", error);
  }
  allStates[network] = {
    ...allStates[network],
    ...state,
    lastUpdated: new Date().toISOString()
  };
  fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(allStates, null, 2));
  console.log(`Updated state for ${network}:`, allStates[network]);
}

async function processLatestBlocks() {
  try {
    await downloadStateFile();

    const ethereumProvider = new ethers.JsonRpcProvider(process.env.ETHEREUM_RPC_URL, { chainId: 1, name: "mainnet" });
    const zksyncProvider = new ethers.JsonRpcProvider(process.env.ZKSYNC_RPC_URL, { chainId: 324, name: "zksync-era" });

    const [ethereumCurrentBlock, zksyncCurrentBlock] = await Promise.all([
      ethereumProvider.getBlockNumber(),
      zksyncProvider.getBlockNumber()
    ]);

    let stateData: Record<string, ProcessingState> = {
      "Ethereum Mainnet": {
        lastProcessedBlock: ethereumCurrentBlock - 100,
        hasError: false,
        lastUpdated: new Date().toISOString()
      },
      "ZKSync": {
        lastProcessedBlock: zksyncCurrentBlock - 100,
        hasError: false,
        lastUpdated: new Date().toISOString()
      }
    };

    if (fs.existsSync(STATE_FILE_PATH)) {
      try {
        const fileContent = fs.readFileSync(STATE_FILE_PATH, "utf8");
        console.log("State file content:", fileContent);
        stateData = JSON.parse(fileContent);
      } catch (error) {
        console.error("Error parsing state file:", error);
      }
    } else {
      fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(stateData, null, 2));
      console.log("Created initial state file");
    }

    const ethereumStartBlock = (stateData["Ethereum Mainnet"]?.lastProcessedBlock ?? ethereumCurrentBlock - 100) + 1;
    const zksyncStartBlock = (stateData["ZKSync"]?.lastProcessedBlock ?? zksyncCurrentBlock - 100) + 1;

    const [ethereumFoundEvents, zksyncFoundEvents] = await Promise.all([
      processBlockRangeForNetwork(
        {
          provider: ethereumProvider,
          eventsMapping: EventsMapping["Ethereum Mainnet"],
          networkName: "Ethereum Mainnet",
          chainId: 1,
          blockExplorerUrl: "https://etherscan.io",
          governanceName: "Ethereum Governance",
          pollInterval: 1000
        },
        ethereumStartBlock,
        ethereumCurrentBlock
      ),
      processBlockRangeForNetwork(
        {
          provider: zksyncProvider,
          eventsMapping: EventsMapping["ZKsync Network"],
          networkName: "ZKSync",
          chainId: 324,
          blockExplorerUrl: "https://explorer.zksync.io",
          governanceName: "ZKSync Governance",
          pollInterval: 1000
        },
        58794460,
        58794464
      )
    ]);

    if (!fs.existsSync(STATE_FILE_PATH)) {
      console.error("State file missing before upload");
      fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(stateData, null, 2));
    }
    await uploadStateFile();

    if (ethereumFoundEvents || zksyncFoundEvents) {
      const updated = await updateRSSFeed();
      console.log(updated ? "RSS feed updated" : "RSS feed unchanged");
    }

    const dataDir = path.join(__dirname, "../data");
    if (fs.existsSync(dataDir)) {
      const files = fs.readdirSync(dataDir);
      if (files.length === 0) {
        fs.rmdirSync(dataDir);
        console.log("Empty data directory cleaned up");
      }
    }
    console.log("Successfully processed all blocks");
  } catch (error) {
    console.error("Failed to process latest blocks:", error);
    try {
      if (fs.existsSync(STATE_FILE_PATH)) {
        await uploadStateFile();
      }
    } catch (uploadError) {
      console.error("Failed to upload state file after error:", uploadError);
    }
    process.exit(1);
  }
}

async function updateProcessingHistory(newRecord: ProcessingRecord) {
  const tempPath = path.join(__dirname, "../data/processing-history.json");
  const dir = path.dirname(tempPath);
  try {
    await acquireLock();
    console.log("Acquired lock for processing history update");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    let history: ProcessingHistory;
    try {
      await downloadFromGCS(GCS_BUCKET_NAME, GCS_HISTORY_FILE_PATH, tempPath);
      history = JSON.parse(fs.readFileSync(tempPath, "utf8"));
      console.log(`Loaded history with ${history.records.length} records`);
    } catch (error) {
      console.log("No existing history found, starting fresh");
      history = { records: [], lastArchiveTimestamp: null };
    }
    history.records.push(newRecord);
    console.log(`Added new record, total records: ${history.records.length}`);
    const now = Date.now();
    const lastArchiveTime = history.lastArchiveTimestamp ? new Date(history.lastArchiveTimestamp).getTime() : 0;
    const shouldArchive =
      history.records.length >= ARCHIVE_THRESHOLD &&
      (!history.lastArchiveTimestamp || now - lastArchiveTime >= MIN_TIME_BETWEEN_ARCHIVES);
    if (shouldArchive) {
      console.log("Archiving records...");
      const archivePath = `state/archive/processing-history-${Date.now()}.json`;
      const recordsToArchive = history.records.slice(0, history.records.length - 100);
      await uploadToGCS(
        GCS_BUCKET_NAME,
        tempPath,
        archivePath,
        JSON.stringify(recordsToArchive)
      );
      history.records = history.records.slice(-100);
      history.lastArchiveTimestamp = new Date().toISOString();
      history.archivedRecords = [
        ...(history.archivedRecords || []),
        { path: archivePath, count: recordsToArchive.length, timestamp: new Date().toISOString() }
      ];
      console.log(`Archived ${recordsToArchive.length} records, keeping ${history.records.length} records`);
    }
    fs.writeFileSync(tempPath, JSON.stringify(history, null, 2));
    await uploadToGCS(GCS_BUCKET_NAME, tempPath, GCS_HISTORY_FILE_PATH);
    console.log("Uploaded updated history to GCS");
    fs.unlinkSync(tempPath);
    await releaseLock();
    console.log("Released lock");
  } catch (error) {
    console.error("Failed to update processing history:", error);
    try {
      if (fs.existsSync(LOCK_FILE_PATH)) {
        await releaseLock();
        console.log("Released lock after error");
      }
    } catch (releaseError) {
      console.error("Failed to release lock:", releaseError);
    }
    throw error;
  }
}

// Error handlers
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
  process.exit(1);
});

// Run the process
processLatestBlocks();
