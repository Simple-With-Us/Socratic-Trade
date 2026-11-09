import { getAlpacaGateway } from "../src/lib/alpaca";

async function main() {
  const gateway = getAlpacaGateway();
  try {
    const accounts = await gateway.getAccounts();
    console.log("Accounts:", accounts);
    
    if (accounts.length > 0) {
      const portfolio = await gateway.getPortfolio(accounts[0].accountNumber);
      console.log("Portfolio:", portfolio);
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

main();
