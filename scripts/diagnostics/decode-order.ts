import { ethers } from "hardhat";

const COMPOUND_TX = "0xa4be74cfb729aaafc189f28b912b60e29d21420f9d173f50936237fdf590f93d";

const EVENT_EMITTER = "0xC8ee91A54287DB53897056e12D9819156D3822Fb";

const HM = "0x9D81A634c269cf262192886B5cC678E00c9D96d8";



async function main() {

  console.log("=== Decode Order Details ===\n");



  const receipt = await ethers.provider.getTransactionReceipt(COMPOUND_TX);



  // Look at the GMX OrderCreated Event

  console.log("\n=== GMX OrderCreated Event ===");

  for (let i = 0; i < receipt!.logs.length; i++) {

    const log = receipt!.logs[i];

    if (log.address.toLowerCase() === EVENT_EMITTER.toLowerCase()) {

      const dataHex = log.data.slice(2).toLowerCase();

      

      // OrderCreated topic hash or data

      if (dataHex.includes('4f7264657243726561746564')) {

        console.log("Found OrderCreated at log index:", i);

        console.log("FULL DATA HEX:", dataHex);

        break;

      }

    }

  }

}



main().catch((error) => {

  console.error(error);

  process.exitCode = 1;

});
